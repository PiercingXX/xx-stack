import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOpencode, runTraceSession, startProxy, summarize } from "./trace-provider-proxy.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-trace-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseArgs(dir: string) {
  return {
    agent: "parallel-execution-orchestrator",
    prompt: "Call check_health only.",
    timeoutSec: 10,
    providerId: "llama-cpp-local",
    upstreamBaseUrl: "http://127.0.0.1:9/v1",
    outputDir: dir,
    runDir: dir,
  };
}

// --- one partial trace line must not discard the post-run summary ------------

test("summarize skips malformed trace lines and reports their count", async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, "proxy-trace.ndjson");
    const request = {
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "request",
      id: "req-1",
      method: "POST",
      path: "/v1/chat/completions",
      bodyText: "Call check_health only. /no_think",
    };
    const response = { timestamp: "2026-01-01T00:00:01.000Z", direction: "response", id: "req-1" };
    const truncated = '{"direction":"request","id":"req-2","method":"POS';
    await writeFile(
      tracePath,
      [JSON.stringify(request), truncated, JSON.stringify(response)].join("\n") + "\n"
    );

    const runLogPath = join(dir, "opencode-run.log");
    await writeFile(
      runLogPath,
      "service=llm agent=parallel-execution-orchestrator check_health invoked\n"
    );

    const summaryPath = join(dir, "summary.json");
    summarize(tracePath, runLogPath, summaryPath, "Call check_health only.");

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    assert.equal(summary.totalProxyRequests, 1);
    assert.equal(summary.malformedTraceLineCount, 1);
    assert.equal(summary.sawNoThinkInOutboundPayload, true);
    assert.equal(summary.sawExactPromptInOutboundPayload, true);
    assert.deepEqual(summary.llmLines, [
      "service=llm agent=parallel-execution-orchestrator check_health invoked",
    ]);
  });
});

test("summarize counts nothing as malformed for a clean trace", async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, "proxy-trace.ndjson");
    const record = { timestamp: "t", direction: "request", id: "req-1" };
    await writeFile(tracePath, `${JSON.stringify(record)}\n`);

    const summaryPath = join(dir, "summary.json");
    summarize(tracePath, join(dir, "missing-run.log"), summaryPath, "prompt");

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    assert.equal(summary.totalProxyRequests, 1);
    assert.equal(summary.malformedTraceLineCount, 0);
  });
});

// --- spawn failures must resolve, not crash the process ----------------------

test("runOpencode resolves nonzero when the command cannot spawn", async () => {
  await withTempDir(async (dir) => {
    const result = await runOpencode(
      baseArgs(dir),
      dir,
      join(dir, "opencode-run.log"),
      "xx-stack-definitely-not-a-real-binary"
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 1);
  });
});

// --- inherited stdio pipes can no longer hang the SIGKILL timeout path -------

test("runOpencode resolves after SIGKILL even when grandchildren inherit stdio pipes", async () => {
  await withTempDir(async (dir) => {
    // The command ignores opencode's argv, spawns a grandchild that inherits
    // its stdio pipes, then stays alive until the run's timeout SIGKILLs it.
    // The grandchild keeps the pipes open, so 'close' would never fire.
    const holderPath = join(dir, "fake-opencode");
    const gcPidFile = join(dir, "grandchild.pid");
    await writeFile(
      holderPath,
      [
        "#!/usr/bin/env node",
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {',
        '  stdio: ["ignore", "inherit", "inherit"],',
        "});",
        "fs.writeFileSync(process.env.GC_PID_FILE, String(grandchild.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    process.env.GC_PID_FILE = gcPidFile;
    try {
      const startedAt = Date.now();
      const result = await runOpencode(
        { ...baseArgs(dir), timeoutSec: 1 },
        dir,
        join(dir, "opencode-run.log"),
        holderPath
      );
      const elapsedMs = Date.now() - startedAt;

      try {
        const pid = Number(await readFile(gcPidFile, "utf8"));
        if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // The grandchild may have already exited; nothing to clean up.
      }

      assert.equal(result.timedOut, true);
      // Without the bounded wait this call hangs until the grandchild exits.
      assert.ok(elapsedMs < 5_000, `must resolve promptly instead of hanging (${elapsedMs}ms)`);
    } finally {
      delete process.env.GC_PID_FILE;
    }
  });
});

// --- a setup failure after listen must close the proxy, never leak it --------

test("a setup failure after listen closes the proxy instead of leaking it", async () => {
  await withTempDir(async (dir) => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const port = (upstream.address() as AddressInfo).port;
      const configPath = join(dir, "opencode-config.json");
      await writeFile(configPath, JSON.stringify({ provider: {} }));

      const outputDir = join(dir, "out");
      // The temp config path is occupied by a directory, so the post-listen
      // config write fails with EISDIR — a stand-in for ENOSPC-style failures.
      await mkdir(join(outputDir, "temp-home", ".config", "opencode", "config.json"), {
        recursive: true,
      });

      const previousConfigPath = process.env.OPENCODE_CONFIG_PATH;
      process.env.OPENCODE_CONFIG_PATH = configPath;

      let closed = false;
      let origin = "";
      try {
        await assert.rejects(
          runTraceSession(
            {
              ...baseArgs(outputDir),
              runDir: join(dir, "run"),
              upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
            },
            {
              startProxy: async (upstreamBaseUrl, traceFile) => {
                const proxy = await startProxy(upstreamBaseUrl, traceFile);
                origin = proxy.origin;
                return {
                  origin: proxy.origin,
                  close: async () => {
                    closed = true;
                    await proxy.close();
                  },
                };
              },
            }
          ),
          /EISDIR/
        );
      } finally {
        if (previousConfigPath === undefined) delete process.env.OPENCODE_CONFIG_PATH;
        else process.env.OPENCODE_CONFIG_PATH = previousConfigPath;
      }

      assert.equal(closed, true, "proxy.close must run even when setup throws");
      // Nothing may be listening anymore; a leaked server would answer this.
      await assert.rejects(fetch(`${origin}/probe-after-close`));
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

// --- a failing trace medium answers 502 instead of crashing the handler ------

test("a failing trace medium answers 502 instead of crashing the request handler", async () => {
  await withTempDir(async (dir) => {
    // The trace file's parent is a regular file, so the append fails (ENOTDIR).
    await writeFile(join(dir, "not-a-directory"), "occupies the path");
    const traceFile = join(dir, "not-a-directory", "proxy-trace.ndjson");

    const proxy = await startProxy("http://127.0.0.1:9/v1", traceFile);
    try {
      const response = await fetch(`${proxy.origin}/chat/completions`, {
        method: "POST",
        body: "ping",
      });
      assert.equal(response.status, 502);
      const payload = (await response.json()) as { error?: string };
      assert.match(payload.error ?? "", /trace write failure/);
    } finally {
      await proxy.close();
    }
  });
});
