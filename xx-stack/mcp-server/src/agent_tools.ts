import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAgentMemoryTools } from "./agent_memory_tools.js";
import { registerAgentProfileTools } from "./agent_profile_tools.js";

export function registerAgentTools(server: McpServer): void {
  registerAgentProfileTools(server);
  registerAgentMemoryTools(server);
}
