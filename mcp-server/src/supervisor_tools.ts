import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSupervisorCompletionTools } from "./supervisor_completion_tools.js";
import { registerSupervisorInspectionTools } from "./supervisor_inspection_tools.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";
import { registerSupervisorSessionTools } from "./supervisor_session_tools.js";

export function registerSupervisorTools(server: McpServer, deps: SupervisorToolDeps): void {
  registerSupervisorSessionTools(server, deps);
  registerSupervisorCompletionTools(server, deps);
  registerSupervisorInspectionTools(server, deps);
}
