import { isAbsolute, relative, resolve } from "node:path";

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

// --- Path confinement -------------------------------------------------------
//
// Several tools take a caller-supplied path (`cwd`, `root`) and hand it straight
// to mkdir-recursive + file creation. A prompt-injected or confused model can
// therefore point those writes anywhere on the machine. The policy mirrors the
// cloud-tier gate: confined by default, with a named env opt-out.

/**
 * Read an xx-stack boolean env flag. Same accepted values as the
 * `XX_STACK_ALLOW_CLOUD` opt-in: unset/anything-else means off.
 */
export function envFlagEnabled(name: string): boolean {
  const value = (process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Is `candidate` inside `root` (or the root itself)? Pure lexical containment
 * on resolved paths, so prefix look-alikes (`/launch-evil` vs `/launch`) and
 * `..` traversal are rejected by construction.
 */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const rest = relative(resolve(root), resolve(candidate));
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/** Env flag that lifts the cwd confinement on the memory tools. */
export const ALLOW_ANY_CWD_ENV = "XX_STACK_ALLOW_ANY_CWD";

export type ConfinedCwd =
  | { ok: true; cwd: string }
  | {
      ok: false;
      reasonCode: "cwd_out_of_bounds";
      cwd: string;
      boundaryRoot: string;
      envOptOut: string;
    };

/**
 * Confine a caller-supplied working directory to the server launch directory.
 *
 * This is the single boundary every filesystem-reaching memory tool applies to
 * its resolved cwd before that cwd can influence any path on disk. Relative
 * paths resolve against the launch directory and land inside it by
 * construction; absolute paths must stay under it unless
 * `XX_STACK_ALLOW_ANY_CWD=1` opts out.
 */
export function confineCwdToLaunchDir(rawCwd: string): ConfinedCwd {
  const cwd = resolve(rawCwd.trim());
  if (envFlagEnabled(ALLOW_ANY_CWD_ENV)) return { ok: true, cwd };
  const boundaryRoot = process.cwd();
  if (isPathWithinRoot(cwd, boundaryRoot)) return { ok: true, cwd };
  return {
    ok: false,
    reasonCode: "cwd_out_of_bounds",
    cwd,
    boundaryRoot,
    envOptOut: ALLOW_ANY_CWD_ENV,
  };
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
