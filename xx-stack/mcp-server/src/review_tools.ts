import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { buildContinuationPrompt } from "./supervisor_completion_tools.js";

const execFileAsync = promisify(execFile);

async function detectGitDiff(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], {
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

export function registerReviewTools(server: McpServer, deps: SupervisorToolDeps): void {
  server.tool(
    "review_to_continuation",
    "Review uncommitted changes and emit a bounded continuation prompt with mustAddress items for every review note",
    {
      sessionId: z.string().describe("Supervisor session ID"),
      diff: z
        .string()
        .optional()
        .describe("Optional diff content; auto-detected from git if omitted"),
      notes: z
        .array(z.string().min(1).max(4000))
        .min(1)
        .max(50)
        .describe("Review notes, each describing a finding that must be addressed"),
    },
    async ({ sessionId, diff, notes }) =>
      deps.withSupervisorStoreLock(async () => {
        const reliability = await deps.loadReliabilityConfig();
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        const state = store.sessions[sessionId];
        if (!state) {
          return jsonContent({ status: "missing", sessionId });
        }

        const effectiveDiff = diff ?? (await detectGitDiff());

        const now = Date.now();
        state.continuationCount += 1;
        state.lastContinuationAt = now;
        deps.pushSessionEvent(state, "review.injected", `review with ${notes.length} notes`);
        await deps.writeSupervisorStore(store);

        const mustAddress = notes.map((note) => ({
          note,
          required: true,
        }));

        const prompt = buildContinuationPrompt(
          sessionId,
          state.continuationCount,
          state.currentRoute,
          state.completionMemorySync,
          /* memorySyncStatus */ null,
          /* completionRecoveryReason */ "review_to_continuation",
          /* remediationChecklist */ [],
          notes,
          [
            "- mustAddress items:",
            ...notes.map((note, i) => `${i + 1}. ${note}`),
            "- diff under review:",
            effectiveDiff.length > 0
              ? effectiveDiff
              : "(no diff detected — review notes apply to the current working tree)",
          ]
        );

        return jsonContent({
          status: "ready",
          reasonCode: "review_to_continuation_emitted",
          sessionId,
          continuationCount: state.continuationCount,
          mustAddress,
          prompt,
        });
      })
  );
}
