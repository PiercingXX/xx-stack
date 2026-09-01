import test from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  resolveToolSurface,
  ROUTING_SURFACE_TOOLS,
  toolAllowedOnSurface,
  wrapServerForSurface,
} from "./tool_surface.js";

test("XX_STACK_TOOL_SURFACE defaults to full; only the literal routing opts in", () => {
  assert.equal(resolveToolSurface({}), "full");
  assert.equal(resolveToolSurface({ XX_STACK_TOOL_SURFACE: "full" }), "full");
  assert.equal(
    resolveToolSurface({ XX_STACK_TOOL_SURFACE: "1" }),
    "full",
    "only 'routing' enables"
  );
  assert.equal(resolveToolSurface({ XX_STACK_TOOL_SURFACE: "true" }), "full");
  assert.equal(resolveToolSurface({ XX_STACK_TOOL_SURFACE: "routing" }), "routing");
});

test("routing surface allows exactly the five routing tools", () => {
  const routing = new Set<string>(ROUTING_SURFACE_TOOLS);
  assert.equal(routing.size, 5);
  for (const name of routing) {
    assert.equal(toolAllowedOnSurface(name, "routing"), true);
    assert.equal(toolAllowedOnSurface(name, "full"), true);
  }
  assert.equal(toolAllowedOnSurface("supervisor_status", "routing"), false);
  assert.equal(toolAllowedOnSurface("supervisor_status", "full"), true);
  assert.equal(toolAllowedOnSurface("_Stop", "routing"), false);
});

test("wrapServerForSurface drops non-routing registrations", () => {
  const names: string[] = [];
  const inner = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as McpServer;

  const full = wrapServerForSurface(inner, "full");
  full.registerTool("supervisor_status", {} as never, (async () => ({})) as never);
  full.registerTool("route_task", {} as never, (async () => ({})) as never);
  assert.deepEqual(names, ["supervisor_status", "route_task"]);

  names.length = 0;
  const routing = wrapServerForSurface(inner, "routing");
  routing.registerTool("supervisor_status", {} as never, (async () => ({})) as never);
  routing.registerTool("list_platforms", {} as never, (async () => ({})) as never);
  routing.registerTool("check_health", {} as never, (async () => ({})) as never);
  routing.registerTool("verify_edit", {} as never, (async () => ({})) as never);
  routing.registerTool("search_tools", {} as never, (async () => ({})) as never);
  assert.deepEqual(names, ["list_platforms", "check_health", "search_tools"]);
});
