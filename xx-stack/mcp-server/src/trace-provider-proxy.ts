#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type ProviderConfig = {
  options?: {
    baseURL?: string;
  };
  baseURL?: string;
  url?: string;
};

type OpenCodeConfig = {
  provider?: Record<string, ProviderConfig>;
};

type CliArgs = {
  agent: string;
  prompt: string;
  timeoutSec: number;
  providerId: string;
  upstreamBaseUrl: string;
  outputDir: string;
  runDir: string;
};

type ProxyRecord = {
  timestamp: string;
  direction: "request" | "response";
  id: string;
  method?: string;
  path?: string;
  upstreamUrl?: string;
  status?: number;
  headers?: Record<string, string | string[]>;
  bodyText?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const defaultsPrompt = "Call check_health only. Keep output short. /no_think";
  const args: CliArgs = {
    agent: "parallel-execution-orchestrator",
    prompt: defaultsPrompt,
    timeoutSec: 120,
    providerId: "llama-cpp-local",
    upstreamBaseUrl: "http://127.0.0.1:8080/v1",
    outputDir: path.join(os.tmpdir(), `opencode-provider-trace-${Date.now()}`),
    runDir: path.join(os.tmpdir(), `opencode-provider-run-${Date.now()}`),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      args.agent = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--prompt" && argv[i + 1]) {
      args.prompt = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--timeout-sec" && argv[i + 1]) {
      args.timeoutSec = Math.max(10, Number(argv[i + 1]) || 120);
      i += 1;
      continue;
    }
    if (arg === "--provider-id" && argv[i + 1]) {
      args.providerId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--upstream-base-url" && argv[i + 1]) {
      args.upstreamBaseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output-dir" && argv[i + 1]) {
      args.outputDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--run-dir" && argv[i + 1]) {
      args.runDir = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function getDefaultConfigPath(): string {
  return (
    process.env.OPENCODE_CONFIG_PATH ||
    path.join(os.homedir(), ".config", "opencode", "config.json")
  );
}

function readJson(filePath: string): OpenCodeConfig {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as OpenCodeConfig;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      out[key] = "<redacted>";
      continue;
    }
    if (typeof value !== "undefined") {
      out[key] = value;
    }
  }
  return out;
}

function clipBody(text: string): string {
  const max = 20000;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function respondJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export async function startProxy(
  upstreamBaseUrl: string,
  traceFile: string
): Promise<{ origin: string; close: () => Promise<void> }> {
  const upstream = new URL(upstreamBaseUrl);
  const upstreamBasePath = upstream.pathname.endsWith("/")
    ? upstream.pathname.slice(0, -1)
    : upstream.pathname;

  const logRecord = (record: ProxyRecord): void => {
    fs.appendFileSync(traceFile, `${JSON.stringify(record)}\n`, "utf8");
  };

  let requestCounter = 0;

  const server = http.createServer(async (req, res) => {
    requestCounter += 1;
    const id = `req-${requestCounter}`;
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", async () => {
      const requestBody = Buffer.concat(chunks);
      const requestPath = req.url || "/";

      const normalizedPath = requestPath.startsWith(upstreamBasePath)
        ? requestPath
        : `${upstreamBasePath}${requestPath.startsWith("/") ? "" : "/"}${requestPath}`;

      const upstreamUrl = `${upstream.origin}${normalizedPath}`;

      // A failing trace medium must degrade to a 502-style answer for this
      // request only; letting the append throw would escape the handler as an
      // unhandled rejection and take down the whole proxy.
      try {
        logRecord({
          timestamp: new Date().toISOString(),
          direction: "request",
          id,
          method: req.method || "GET",
          path: requestPath,
          upstreamUrl,
          headers: sanitizeHeaders(req.headers),
          bodyText: clipBody(requestBody.toString("utf8")),
        });
      } catch (error) {
        respondJson(res, 502, { error: `trace write failure: ${describeError(error)}` });
        return;
      }

      try {
        const response = await fetch(upstreamUrl, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: requestBody.length > 0 ? requestBody : undefined,
        });

        const responseText = await response.text();

        logRecord({
          timestamp: new Date().toISOString(),
          direction: "response",
          id,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          bodyText: clipBody(responseText),
        });

        res.statusCode = response.status;
        for (const [key, value] of response.headers.entries()) {
          res.setHeader(key, value);
        }
        res.end(responseText);
      } catch (error) {
        const message = describeError(error);
        try {
          logRecord({
            timestamp: new Date().toISOString(),
            direction: "response",
            id,
            status: 502,
            bodyText: `proxy error: ${message}`,
          });
        } catch {
          // The trace medium is failing; answering the client still comes first.
        }
        respondJson(res, 502, { error: `proxy error: ${message}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind proxy server");
  }

  const proxyBase = `http://127.0.0.1:${address.port}${upstreamBasePath}`;

  return {
    origin: proxyBase,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/**
 * How long the child's stdio pipes get to drain after it exits. A grandchild
 * inheriting those pipes can stall the 'close' event forever, so resolution
 * falls back to 'exit' once this grace window elapses.
 */
const CLOSE_GRACE_MS = 250;

export async function runOpencode(
  args: CliArgs,
  tempHome: string,
  runLogPath: string,
  command: string = "opencode"
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const out = fs.createWriteStream(runLogPath, { flags: "w" });
    const child = spawn(
      command,
      ["run", "--agent", args.agent, "--print-logs", "--dir", args.runDir, args.prompt],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          XDG_CONFIG_HOME: path.join(tempHome, ".config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let timedOut = false;
    let settled = false;
    let sawExit = false;
    let pipesClosed = false;
    let exitCode: number | null = null;
    let closeGrace: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeGrace !== undefined) clearTimeout(closeGrace);
      out.end();
      resolve({ exitCode, timedOut });
    };

    child.stdout.on("data", (d) => {
      if (!settled) out.write(d);
    });
    child.stderr.on("data", (d) => {
      if (!settled) out.write(d);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, args.timeoutSec * 1000);

    child.on("error", () => {
      // Spawn failures (ENOENT and friends) never produce a process; report a
      // nonzero exit code so callers see a failed run instead of crashing on
      // an unhandled 'error' event.
      if (!sawExit) exitCode = 1;
      finish();
    });

    child.on("exit", (code) => {
      sawExit = true;
      exitCode = code;
      if (pipesClosed) {
        finish();
        return;
      }
      closeGrace = setTimeout(() => {
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
        finish();
      }, CLOSE_GRACE_MS);
    });

    child.on("close", () => {
      pipesClosed = true;
      if (sawExit) finish();
    });
  });
}

export function summarize(
  tracePath: string,
  runLogPath: string,
  summaryPath: string,
  prompt: string
): void {
  const traceLines = fs.existsSync(tracePath)
    ? fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean)
    : [];

  // Parse per line: one partial/corrupt record must not discard the whole
  // post-run summary. Skip malformed lines and report how many there were.
  const requests: ProxyRecord[] = [];
  let malformedTraceLineCount = 0;
  for (const line of traceLines) {
    try {
      const record = JSON.parse(line) as ProxyRecord;
      if (record.direction === "request") requests.push(record);
    } catch {
      malformedTraceLineCount += 1;
    }
  }

  const requestBodies = requests.map((r) => r.bodyText || "");
  const sawNoThink = requestBodies.some((body) => body.includes("/no_think"));
  const sawPromptLiteral = requestBodies.some((body) => body.includes(prompt));

  const runLog = fs.existsSync(runLogPath) ? fs.readFileSync(runLogPath, "utf8") : "";
  const llmLines = runLog
    .split("\n")
    .filter(
      (line) =>
        line.includes("service=llm") && line.includes("agent=parallel-execution-orchestrator")
    );
  const toolCallSignals = runLog
    .split("\n")
    .filter((line) => /check_health|list_platforms|route_parallel_tasks/.test(line));

  const summary = {
    createdAt: new Date().toISOString(),
    tracePath,
    runLogPath,
    totalProxyRequests: requests.length,
    malformedTraceLineCount,
    sawNoThinkInOutboundPayload: sawNoThink,
    sawExactPromptInOutboundPayload: sawPromptLiteral,
    llmLines,
    toolCallSignalCount: toolCallSignals.length,
    toolCallSignalPreview: toolCallSignals.slice(0, 20),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

export type TraceSessionResult = {
  proxyOrigin: string;
  runResult: { exitCode: number | null; timedOut: boolean };
};

export type TraceSessionDeps = {
  startProxy?: typeof startProxy;
};

export async function runTraceSession(
  args: CliArgs,
  deps: TraceSessionDeps = {}
): Promise<TraceSessionResult> {
  const start = deps.startProxy ?? startProxy;

  ensureDir(args.outputDir);
  ensureDir(args.runDir);

  const tracePath = path.join(args.outputDir, "proxy-trace.ndjson");
  const runLogPath = path.join(args.outputDir, "opencode-run.log");
  const summaryPath = path.join(args.outputDir, "summary.json");
  const tempHome = path.join(args.outputDir, "temp-home");

  ensureDir(path.join(tempHome, ".config", "opencode"));

  const sourceConfigPath = getDefaultConfigPath();
  const config = readJson(sourceConfigPath);
  config.provider = config.provider || {};

  const provider = config.provider[args.providerId] || {};
  const currentBaseUrl =
    provider.options?.baseURL || provider.baseURL || provider.url || args.upstreamBaseUrl;

  const proxy = await start(currentBaseUrl, tracePath);

  let runResult: { exitCode: number | null; timedOut: boolean };
  try {
    const nextProvider: ProviderConfig = {
      ...provider,
      options: {
        ...(provider.options || {}),
        baseURL: proxy.origin,
      },
    };
    config.provider[args.providerId] = nextProvider;

    const tempConfigPath = path.join(tempHome, ".config", "opencode", "config.json");
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

    runResult = await runOpencode(args, tempHome, runLogPath);
  } finally {
    // Setup or the traced run can throw (config write ENOSPC and friends); the
    // listening proxy must never leak either way. Close errors are swallowed
    // so they cannot mask the original failure.
    await proxy.close().catch(() => undefined);
  }

  summarize(tracePath, runLogPath, summaryPath, args.prompt);

  console.log(`trace written to: ${args.outputDir}`);
  console.log(`run log: ${runLogPath}`);
  console.log(`proxy trace: ${tracePath}`);
  console.log(`summary: ${summaryPath}`);
  console.log(`exitCode: ${String(runResult.exitCode)} timedOut: ${String(runResult.timedOut)}`);

  return { proxyOrigin: proxy.origin, runResult };
}

async function main(): Promise<void> {
  await runTraceSession(parseArgs(process.argv.slice(2)));
}

// --- Direct execution guard (same realpath pattern as cli.ts / index.ts) ---
// Without it, importing this module from a test would spawn a live run.

const isDirectExecution = ((): boolean => {
  if (!process.argv[1]) return false;
  const realOrSelf = (candidate: string): string => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main().catch((error) => {
    console.error(`trace-provider-proxy failed: ${describeError(error)}`);
    process.exit(1);
  });
}
