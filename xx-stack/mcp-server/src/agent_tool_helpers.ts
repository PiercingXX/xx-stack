import type { loadMergedAgentRuntimeConfig } from "./config_runtime.js";

type LoadedAgentRuntime = Awaited<ReturnType<typeof loadMergedAgentRuntimeConfig>>;

export type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

/** Wrap a payload as an MCP text-content tool result. */
export function jsonContent(payload: unknown): JsonToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Build a deterministic continuation prompt in the same structured format
 * used by supervisor_emit_continuation_prompt.
 *
 * @param directive  Header line (e.g. "Review continuation directive:")
 * @param metadata   Key-value pairs to emit as `- key: value` lines after the header
 * @param requirements  Bullet-point requirements under `- requirements:`
 * @param sections  Ordered list of `{ heading, items }` — each rendered as `- heading:` with numbered items
 */
export function buildContinuationPrompt(
  directive: string,
  metadata: Record<string, string>,
  requirements: string[],
  sections: Array<{ heading: string; items: string[] }>
): string {
  const lines: string[] = [directive];

  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`- ${key}: ${value}`);
  }

  lines.push("- requirements:");
  for (const req of requirements) {
    lines.push(`  - ${req}`);
  }

  for (const { heading, items } of sections) {
    lines.push(`- ${heading}:`);
    for (let i = 0; i < items.length; i++) {
      lines.push(`  ${i + 1}. ${items[i]}`);
    }
  }

  return lines.join("\n");
}

export function buildCoordinatorContract(
  agentId: string,
  strict: boolean,
  structuredResults: boolean
): string {
  const lines: string[] = [
    `Coordinator contract for ${agentId}:`,
    "1. Treat worker notifications as internal signals, not user conversation turns.",
    "2. Never fabricate worker outcomes; only summarize received deterministic results.",
    "3. Worker prompts must be self-contained and include exact files, commands, and acceptance checks.",
    "4. Reuse the same worker for follow-up when context continuity matters.",
    "5. Stop or reroute workers immediately when requirements change.",
    "6. For parallel work, fan out independent research/verification slices in one batch.",
  ];

  if (strict) {
    lines.push(
      "7. Strict mode: do not delegate trivial readback tasks that can be answered directly."
    );
    lines.push(
      "8. Strict mode: require a concise synthesis step before issuing implementation follow-ups."
    );
  }
  if (structuredResults) {
    lines.push(
      "9. Require worker outputs to include scope, result, changed files, and open issues."
    );
  }
  return lines.join("\n");
}

export function resolveAgentContext(
  agentId: string,
  memoryScope: "user" | "project" | "local" | undefined,
  cwd: string | undefined,
  runtime: LoadedAgentRuntime
): {
  profile: LoadedAgentRuntime["agents"][string] | undefined;
  resolvedScope: "user" | "project" | "local";
  resolvedCwd: string;
} {
  const profile = runtime.agents[agentId];
  return {
    profile,
    resolvedScope: memoryScope ?? profile?.memory?.scope ?? "project",
    resolvedCwd: cwd?.trim() || process.cwd(),
  };
}
