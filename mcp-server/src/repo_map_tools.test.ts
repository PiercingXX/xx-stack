import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRepoMapTools, ALLOW_ANY_ROOT_ENV } from "./repo_map_tools.js";
import { ALLOW_ANY_CWD_ENV } from "./agent_tool_helpers.js";

// ---------------------------------------------------------------------------
// build_repo_map's root boundary. An unconstrained root turned the tool into
// machine-wide directory enumeration; it is now confined to the server launch
// directory by default, with injected allowedRoots for tests and a named env
// opt-out — enforced here at the tool boundary so buildRepoMap callers (runtime
// tests, golden tasks) keep their contract.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureRepoMapTool(deps: Parameters<typeof registerRepoMapTools>[1] = {}): ToolHandler {
  let handler: ToolHandler = async () => ({ content: [] });
  const fakeServer = {
    registerTool: (...args: unknown[]) => {
      handler = args[args.length - 1] as ToolHandler;
    },
  } as unknown as McpServer;
  registerRepoMapTools(fakeServer, deps);
  return handler;
}

async function callTool(
  handler: ToolHandler,
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const result = await handler(args);
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

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

test("build_repo_map rejects roots outside the launch directory by default", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, undefined, async () => {
    const outside = await mkdtemp(join(tmpdir(), "xx-stack-repomap-outside-"));
    try {
      const payload = await callTool(captureRepoMapTool(), { root: outside, tokenBudget: 100 });
      assert.equal(payload.status, "error");
      assert.equal(payload.reasonCode, "root_out_of_bounds");
      assert.equal(payload.root, outside);
      assert.deepEqual(payload.boundaryRoots, [process.cwd()]);
      assert.match(payload.hint, /XX_STACK_ALLOW_ANY_ROOT=1/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("injected allowedRoots admit fixture roots without weakening the runtime", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, undefined, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "xx-stack-repomap-fixture-"));
    try {
      await writeFile(join(fixture, "app.ts"), "export const app = 1;\n", "utf8");
      const handler = captureRepoMapTool({ allowedRoots: [fixture] });

      const payload = await callTool(handler, { root: fixture, tokenBudget: 500 });
      assert.equal(
        payload.status,
        undefined,
        "an admitted root returns a normal map, not an error"
      );
      assert.ok(
        payload.files.some((f: { path: string }) => f.path === "app.ts"),
        "the fixture file is mapped"
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("XX_STACK_ALLOW_ANY_ROOT=1 lifts the boundary", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, "1", async () => {
    const outside = await mkdtemp(join(tmpdir(), "xx-stack-repomap-optin-"));
    try {
      await writeFile(join(outside, "lib.rs"), "fn main() {}\n", "utf8");
      const payload = await callTool(captureRepoMapTool(), { root: outside, tokenBudget: 500 });
      assert.ok(payload.files.some((f: { path: string }) => f.path === "lib.rs"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("a relative root resolves against the launch directory and passes", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, undefined, async () => {
    // The launch directory itself is admissible; "." proves both the relative
    // resolution and the containment admission in one call.
    const payload = await callTool(captureRepoMapTool(), { root: ".", tokenBudget: 2000 });
    assert.equal(payload.status, undefined);
    assert.ok(payload.files.length > 0, "the mcp-server sources are mapped");
    assert.ok(
      payload.files.every((f: { path: string }) => !f.path.startsWith("..")),
      "no mapped path may escape the launch directory"
    );
  });
});

test("a traversal root is rejected by lexical containment", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, undefined, async () => {
    await withEnvAsync(ALLOW_ANY_CWD_ENV, undefined, async () => {
      const payload = await callTool(captureRepoMapTool(), {
        root: join(process.cwd(), "..", "elsewhere"),
        tokenBudget: 100,
      });
      assert.equal(payload.status, "error");
      assert.equal(payload.reasonCode, "root_out_of_bounds");
    });
  });
});

test("sibling directories sharing the name prefix do not pass", async () => {
  await withEnvAsync(ALLOW_ANY_ROOT_ENV, undefined, async () => {
    await mkdir(`${process.cwd()}-repomap-sibling-check`, { recursive: true });
    try {
      const payload = await callTool(captureRepoMapTool(), {
        root: `${process.cwd()}-repomap-sibling-check`,
        tokenBudget: 100,
      });
      assert.equal(payload.status, "error");
    } finally {
      await rm(`${process.cwd()}-repomap-sibling-check`, { recursive: true, force: true });
    }
  });
});
