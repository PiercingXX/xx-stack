import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAgentProfileTools } from "./agent_profile_tools.js";

// ---------------------------------------------------------------------------
// config_runtime now reports `configErrors` and per-file
// `sources.{repoConfigStatus,userConfigStatus}`, so a config file that exists
// but does not parse is distinguishable from one that is simply absent.
// agent_preflight did not surface any of it: a malformed config contributes no
// agents and no MCP server names, so the tool answered `missing_agent` or
// `missing_required_mcp` — pointing the caller at the wrong problem entirely.
// ---------------------------------------------------------------------------

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_REPO = process.env.XX_STACK_REPO;

function restore(name: "HOME" | "XX_STACK_REPO", original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/**
 * Config paths resolve from $HOME and $XX_STACK_REPO; both point at a
 * throwaway dir so the developer's real config is never read. node --test
 * isolates each test file in its own process, so this cannot leak.
 */
async function withTempConfig(
  userConfig: string | null,
  work: (homeDir: string) => Promise<void>
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-preflight-"));
  process.env.HOME = homeDir;
  process.env.XX_STACK_REPO = homeDir;
  await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
  try {
    if (userConfig !== null) {
      await writeFile(join(homeDir, ".config/opencode/config.json"), userConfig, "utf-8");
    }
    await work(homeDir);
  } finally {
    restore("HOME", ORIGINAL_HOME);
    restore("XX_STACK_REPO", ORIGINAL_REPO);
    await rm(homeDir, { recursive: true, force: true });
  }
}

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureProfileTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    registerTool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;
  registerAgentProfileTools(fakeServer);
  return handlers;
}

async function preflight(args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await captureProfileTools().agent_preflight!(args);
  return JSON.parse(result.content[0]!.text);
}

const VALID_CONFIG = JSON.stringify({
  agent: {
    reviewer: {
      mode: "subagent",
      requiredMcpServers: ["xx-stack"],
      toolPolicy: { allow: ["task_*"], deny: [] },
    },
  },
  mcp: { "xx-stack": {} },
});

test("agent_preflight reports an unparseable config as config_invalid, not missing_required_mcp", async () => {
  await withTempConfig("{ this is not json", async () => {
    const payload = await preflight({ agentId: "reviewer" });

    assert.equal(
      payload.status,
      "config_invalid",
      "an unusable config must not be diagnosed as a missing agent or a missing MCP server"
    );
    assert.equal(payload.configErrors.length, 1, "the offending file is reported");
    assert.equal(payload.configErrors[0].code, "invalid_config");
    assert.ok(payload.configErrors[0].path.endsWith("config.json"));
    assert.ok(typeof payload.configErrors[0].message === "string");
    // A malformed user config is distinguishable from an absent one.
    assert.equal(payload.sources.userConfigStatus, "invalid");
  });
});

test("a missing config is still reported as missing, never as invalid", async () => {
  await withTempConfig(null, async () => {
    const payload = await preflight({ agentId: "reviewer" });

    assert.equal(
      payload.status,
      "missing_agent",
      "no config file means the agent is simply absent"
    );
    assert.deepEqual(payload.configErrors, []);
    assert.equal(payload.sources.userConfigStatus, "missing");
  });
});

test("a valid config still preflights ok/blocked exactly as before", async () => {
  await withTempConfig(VALID_CONFIG, async () => {
    const ok = await preflight({ agentId: "reviewer", requestedTools: ["task_get"] });
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.configErrors, []);
    assert.deepEqual(ok.missingRequiredMcpServers, []);
    assert.equal(ok.sources.userConfigStatus, "ok");

    const missingAgent = await preflight({ agentId: "not-configured" });
    assert.equal(missingAgent.status, "missing_agent");
  });
});

test("a genuinely missing MCP server is still 'blocked', a distinct diagnosis from config_invalid", async () => {
  const noServers = JSON.stringify({
    agent: { reviewer: { requiredMcpServers: ["xx-stack"] } },
    mcp: {},
  });
  await withTempConfig(noServers, async () => {
    const payload = await preflight({ agentId: "reviewer" });
    assert.equal(payload.status, "blocked");
    assert.deepEqual(payload.missingRequiredMcpServers, ["xx-stack"]);
    assert.deepEqual(payload.configErrors, []);
  });
});
