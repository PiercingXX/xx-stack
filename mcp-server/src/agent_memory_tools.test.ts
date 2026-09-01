import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getAgentMemoryEntrypoint } from "./memory_runtime.js";
import { emitAgentMemoryCompactionPrompt, registerAgentMemoryTools } from "./agent_memory_tools.js";
import { ALLOW_ANY_CWD_ENV } from "./agent_tool_helpers.js";

// ---------------------------------------------------------------------------
// The cwd boundary on the filesystem-reaching memory tools: a caller-supplied
// cwd used to flow verbatim into mkdir-recursive + file creation anywhere on
// the machine. Default-confined to the server launch directory; structured
// error; XX_STACK_ALLOW_ANY_CWD=1 opts out.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureMemoryTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (...toolArgs: unknown[]) => {
      handlers.set(toolArgs[0] as string, toolArgs[toolArgs.length - 1] as ToolHandler);
    },
  } as unknown as McpServer;
  registerAgentMemoryTools(fakeServer);
  return handlers;
}

async function callTool(
  handlers: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const handler = handlers.get(name);
  assert.ok(handler, `tool ${name} should be registered`);
  const result = await handler!(args);
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

/** Save/delete/set/restore around an async body so no state leaks between tests. */
async function withEnvAsync(
  name: string,
  value: string | undefined,
  body: () => Promise<void>
): Promise<void> {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    await body();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** An absolute cwd guaranteed outside the server launch directory. */
async function outsideTmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "xx-stack-memory-boundary-"));
}

test("an out-of-bounds cwd is rejected structurally before anything touches disk", async () => {
  await withEnvAsync(ALLOW_ANY_CWD_ENV, undefined, async () => {
    const handlers = captureMemoryTools();
    const outside = await outsideTmpRoot();
    try {
      const payload = await callTool(handlers, "agent_memory_append", {
        agentId: "boundary-agent",
        scope: "project",
        cwd: outside,
        note: "should never land",
      });

      assert.equal(payload.status, "error");
      assert.equal(payload.reasonCode, "cwd_out_of_bounds");
      assert.equal(payload.cwd, outside);
      assert.equal(payload.boundaryRoot, process.cwd());
      assert.ok(
        !existsSync(getAgentMemoryEntrypoint("boundary-agent", "project", outside)),
        "no MEMORY.md may be created outside the boundary"
      );
      assert.ok(
        !existsSync(join(outside, ".xx-stack")),
        "not even the scoped state directory may be created"
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("every filesystem-reaching memory tool enforces the same boundary", async () => {
  await withEnvAsync(ALLOW_ANY_CWD_ENV, undefined, async () => {
    const handlers = captureMemoryTools();
    const outside = await outsideTmpRoot();
    try {
      const base = { agentId: "boundary-agent", scope: "project", cwd: outside };
      for (const [tool, args] of [
        ["agent_memory_get", base],
        ["agent_memory_snapshot_sync", base],
        ["agent_memory_mark_superseded", { ...base, entryIds: ["e1"], supersededBy: "rule-1" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const payload = await callTool(handlers, tool, args);
        assert.equal(payload.status, "error", `${tool} must be confined`);
        assert.equal(payload.reasonCode, "cwd_out_of_bounds", `${tool} must name the reason`);
      }
      const compaction = JSON.parse(
        (
          await emitAgentMemoryCompactionPrompt({
            agentId: "boundary-agent",
            scope: "project",
            cwd: outside,
            maxEntries: 3,
          })
        ).content[0]!.text
      );
      assert.equal(compaction.status, "error", "compaction prompt must be confined");
      assert.equal(compaction.reasonCode, "cwd_out_of_bounds");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("XX_STACK_ALLOW_ANY_CWD=1 restores access to out-of-bounds roots", async () => {
  await withEnvAsync(ALLOW_ANY_CWD_ENV, "1", async () => {
    const handlers = captureMemoryTools();
    const outside = await outsideTmpRoot();
    try {
      const appended = await callTool(handlers, "agent_memory_append", {
        agentId: "boundary-optin-agent",
        scope: "project",
        cwd: outside,
        note: "opted in",
      });
      assert.equal(appended.status, "ok");
      assert.ok(existsSync(appended.path), "the opt-in must really lift the boundary");

      const read = await callTool(handlers, "agent_memory_get", {
        agentId: "boundary-optin-agent",
        scope: "project",
        cwd: outside,
      });
      assert.equal(read.status, "ok");
      assert.ok(read.content.includes("opted in"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("user-scope calls are not gated by a cwd they never use", async () => {
  await withEnvAsync(ALLOW_ANY_CWD_ENV, undefined, async () => {
    const handlers = captureMemoryTools();
    const agentId = "boundary-user-scope-agent";
    const memoryPath = getAgentMemoryEntrypoint(agentId, "user", process.cwd());
    try {
      const outside = await outsideTmpRoot();
      const payload = await callTool(handlers, "agent_memory_get", {
        agentId,
        scope: "user",
        cwd: outside,
      });
      assert.equal(payload.status, "ok");
      assert.equal(payload.path, memoryPath, "user memory lives under homedir regardless of cwd");
    } finally {
      await rm(dirname(memoryPath), { recursive: true, force: true });
    }
  });
});
