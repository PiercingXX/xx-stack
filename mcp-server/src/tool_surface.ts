import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Optional reduction of the MCP tool surface.
 *
 * Default is `full` (every cataloged tool plus hook tools when that flag is
 * on). `routing` keeps only the five tools a host needs to pick a lane:
 * inventory, health, single/parallel routing, and catalog search. Search
 * filters the catalog to the same set so it cannot advertise a tool that is
 * not registered.
 *
 * Opt in with XX_STACK_TOOL_SURFACE=routing. Any other value, including unset,
 * is `full` — a typo must not hide the suite.
 */
export const TOOL_SURFACE_ENV = "XX_STACK_TOOL_SURFACE";

export type ToolSurface = "routing" | "full";

export const ROUTING_SURFACE_TOOLS = [
  "list_platforms",
  "check_health",
  "route_task",
  "route_parallel_tasks",
  "search_tools",
] as const;

export type RoutingSurfaceTool = (typeof ROUTING_SURFACE_TOOLS)[number];

const ROUTING_SURFACE_TOOL_SET: ReadonlySet<string> = new Set(ROUTING_SURFACE_TOOLS);

export function resolveToolSurface(env: NodeJS.Dict<string> = process.env): ToolSurface {
  return env[TOOL_SURFACE_ENV] === "routing" ? "routing" : "full";
}

export function toolAllowedOnSurface(name: string, surface: ToolSurface): boolean {
  if (surface === "full") return true;
  return ROUTING_SURFACE_TOOL_SET.has(name);
}

/**
 * Drop registrations that the current surface does not expose. `full` returns
 * the original server so the common path pays no proxy.
 */
export function wrapServerForSurface(
  server: McpServer,
  surface: ToolSurface = resolveToolSurface()
): McpServer {
  if (surface === "full") return server;
  const registerTool = server.registerTool.bind(server) as McpServer["registerTool"];
  return new Proxy(server, {
    get(target, prop, receiver): unknown {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver);
      }
      return ((name: string, config: never, handler: never) => {
        if (!ROUTING_SURFACE_TOOL_SET.has(name)) return;
        return registerTool(name, config, handler);
      }) as McpServer["registerTool"];
    },
  });
}
