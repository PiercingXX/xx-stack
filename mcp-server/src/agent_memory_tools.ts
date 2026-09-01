import { appendFile, open, stat } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadMergedAgentRuntimeConfig } from "./config_runtime.js";
import {
  buildMemoryCompactionPrompt,
  buildMemoryResyncHelperPrompt,
  ensureMemoryEntrypoint,
  getAgentMemoryEntrypoint,
  getAgentMemorySnapshotMetaPath,
  getAgentMemorySnapshotPath,
  hashMemoryContent,
  lineDiffSummary,
  markAgentMemorySupersededOnDisk,
  readMemoryEntrypoint,
  readSnapshotMeta,
  selectMemoryForBudget,
  syncAgentMemorySnapshot,
} from "./memory_runtime.js";
import {
  confineCwdToLaunchDir,
  jsonContent,
  resolveAgentContext,
  type JsonToolResult,
} from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";

/**
 * Does MEMORY.md need a healing `\n` before the next entry?
 *
 * `parseMemoryEntries` is line-based: an entry is one `- <iso> <note>` line.
 * A file that does not end in a newline concatenates the next append onto its
 * last line, which merges two entries into one unparseable record. Two ways
 * that happens here, and the second is not a rare race:
 *
 *   1. A torn write — ENOSPC mid-line, a killed process, an external truncation.
 *   2. The very first append onto a file whose scaffold or hand-edited tail has
 *      no trailing newline. `ensureMemoryEntrypoint` writes a well-formed
 *      template, but MEMORY.md is a user-visible file people edit by hand.
 *
 * Reading the last byte answers the question the append depends on. A `stat`
 * that fails yields false, so the append proceeds unchanged and reports its own
 * error rather than one from the check.
 *
 * The same shape exists in `log_worker.ts` and is deliberately not shared: that
 * one must route every filesystem call through the `__logIo` test seam, and
 * importing a telemetry seam into the memory path would couple them for two
 * dozen lines.
 */
async function needsLeadingNewline(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, size - 1);
    return bytesRead === 1 && buf[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * The one boundary every filesystem-reaching memory tool applies before its
 * resolved cwd can influence a path on disk: project scope writes under
 * `<cwd>/.xx-stack/` and local scope keys a home-directory path off it, so an
 * unconstrained cwd is an arbitrary-directory write. User scope never touches
 * the cwd (its files live under homedir), so it passes through unconfined.
 *
 * Returns the structured error result when the cwd escapes the server launch
 * directory and `XX_STACK_ALLOW_ANY_CWD` has not opted out; null when the call
 * may proceed.
 */
function cwdOutOfBoundsResult(
  agentId: string,
  resolvedScope: "user" | "project" | "local",
  resolvedCwd: string
): JsonToolResult | null {
  if (resolvedScope === "user") return null;
  const confined = confineCwdToLaunchDir(resolvedCwd);
  if (confined.ok) return null;
  return jsonContent({
    status: "error",
    reasonCode: confined.reasonCode,
    agentId,
    scope: resolvedScope,
    cwd: confined.cwd,
    boundaryRoot: confined.boundaryRoot,
    hint: `cwd escapes the server launch directory (${confined.boundaryRoot}); pass a repo under it or set ${confined.envOptOut}=1`,
  });
}

export interface EmitAgentMemoryCompactionPromptArgs {
  agentId: string;
  scope?: "user" | "project" | "local";
  cwd?: string;
  maxEntries?: number;
}

/**
 * Distillation prompt plus candidate memory entries. Not an MCP tool; compose
 * via the compose-supervisor-prompts skill. The server never calls a model.
 */
export async function emitAgentMemoryCompactionPrompt({
  agentId,
  scope,
  cwd,
  maxEntries,
}: EmitAgentMemoryCompactionPromptArgs): Promise<JsonToolResult> {
  const runtime = await loadMergedAgentRuntimeConfig();
  const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
  const blocked = cwdOutOfBoundsResult(agentId, resolvedScope, resolvedCwd);
  if (blocked) return blocked;
  const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
  await ensureMemoryEntrypoint(path);
  const content = await readMemoryEntrypoint(path);

  const result = buildMemoryCompactionPrompt(agentId, content, maxEntries);
  return jsonContent({
    status: "ok",
    agentId,
    scope: resolvedScope,
    path,
    compactionId: result.compactionId,
    prompt: result.prompt,
    candidates: result.candidates,
    entriesTotal: result.entriesTotal,
    entriesEligible: result.entriesEligible,
  });
}

export function registerAgentMemoryTools(server: McpServer): void {
  server.registerTool(
    "agent_memory_get",
    {
      description:
        "Read persistent memory entrypoint for an agent and scope. When tokenBudget is set, entries are fitted to the budget via submodular selection (relevant to the optional query + diverse, stable original order).",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent identifier"),
        scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional project root for project/local scope; must lie under the server launch directory unless XX_STACK_ALLOW_ANY_CWD=1"
          ),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional token budget; when set, recall is fitted to this budget"),
        query: z
          .string()
          .optional()
          .describe("Optional relevance query for budgeted recall (ignored without tokenBudget)"),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            "When true, budgeted recall also considers superseded entries (ignored without tokenBudget)"
          ),
      },
      annotations: toolAnnotations("agent_memory_get"),
    },
    async ({ agentId, scope, cwd, tokenBudget, query, includeSuperseded }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const blocked = cwdOutOfBoundsResult(agentId, resolvedScope, resolvedCwd);
      if (blocked) return blocked;
      const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      await ensureMemoryEntrypoint(path);
      const content = await readMemoryEntrypoint(path);

      const snapshotPath = getAgentMemorySnapshotPath(agentId, resolvedScope, resolvedCwd);
      const metaPath = getAgentMemorySnapshotMetaPath(agentId, resolvedScope, resolvedCwd);
      const snapshotContent = await readMemoryEntrypoint(snapshotPath);
      const meta = await readSnapshotMeta(metaPath);
      const memoryHash = hashMemoryContent(content);
      const snapshotHash = hashMemoryContent(snapshotContent);
      const diff = lineDiffSummary(snapshotContent, content);
      const lastSyncedMemoryHash =
        typeof meta?.lastSyncedMemoryHash === "string" ? meta.lastSyncedMemoryHash : null;
      const driftDetected = memoryHash !== snapshotHash;
      const snapshot = {
        status: driftDetected ? "drifted" : "synced",
        memoryPath: path,
        snapshotPath,
        metaPath,
        memoryHash,
        snapshotHash,
        lastSyncedMemoryHash,
        driftDetected,
        diff,
        helperPrompt: driftDetected
          ? buildMemoryResyncHelperPrompt(agentId, resolvedScope, diff)
          : null,
      };

      if (tokenBudget === undefined) {
        return jsonContent({
          status: "ok",
          agentId,
          scope: resolvedScope,
          path,
          content,
          snapshot,
        });
      }

      const recall = selectMemoryForBudget(content, tokenBudget, query, includeSuperseded === true);
      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path,
        content: recall.content,
        snapshot,
        recall: {
          tokenBudget: recall.tokenBudget,
          tokensEstimated: recall.tokensEstimated,
          entriesTotal: recall.entriesTotal,
          entriesSelected: recall.entriesSelected,
          entriesSuperseded: recall.entriesSuperseded,
          truncated: recall.truncated,
        },
      });
    }
  );

  server.registerTool(
    "agent_memory_append",
    {
      description: "Append a timestamped memory note for an agent and scope",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent identifier"),
        note: z.string().min(1).max(8000).describe("Memory note content"),
        scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional project root for project/local scope; must lie under the server launch directory unless XX_STACK_ALLOW_ANY_CWD=1"
          ),
      },
      annotations: toolAnnotations("agent_memory_append"),
    },
    async ({ agentId, note, scope, cwd }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const blocked = cwdOutOfBoundsResult(agentId, resolvedScope, resolvedCwd);
      if (blocked) return blocked;
      const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      await ensureMemoryEntrypoint(path);
      const entry = `- ${new Date().toISOString()} ${note.trim()}\n`;
      // A real append, not read-modify-write. atomicWriteTextFile makes the
      // *replace* atomic, not the read-then-write around it: two concurrent
      // appends both read the same bytes and the second write silently drops
      // the first entry. Append is the path agents call most and the only
      // memory write with no expectedHash precondition, so it gets O_APPEND —
      // which the kernel serializes — instead of an optimistic-concurrency
      // dance the caller would have to retry.
      //
      // The healing newline rides in the SAME appendFile call. A separate
      // append re-opens the exact tear window it is closing — and, under
      // O_APPEND with concurrent writers, would let another entry land between
      // the two calls and be split by the newline meant for the previous one.
      const heal = (await needsLeadingNewline(path)) ? "\n" : "";
      await appendFile(path, heal + entry, "utf-8");

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path,
        appended: entry.trim(),
      });
    }
  );

  server.registerTool(
    "agent_memory_snapshot_sync",
    {
      description:
        "Sync memory snapshots by capturing current memory or applying snapshot back to live memory. Pass expectedHash (from agent_memory_snapshot_status) for a compare-and-swap write: on mismatch nothing is written and a write_conflict is returned.",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent identifier"),
        scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional project root for project/local scope; must lie under the server launch directory unless XX_STACK_ALLOW_ANY_CWD=1"
          ),
        direction: z
          .enum(["capture", "apply"])
          .optional()
          .describe("capture: memory -> snapshot; apply: snapshot -> memory"),
        retainHistory: z
          .boolean()
          .optional()
          .describe("When true, store timestamped copies under .snapshots/"),
        expectedHash: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional precondition on the file this sync overwrites (memoryHash for direction 'apply', snapshotHash for 'capture', both from agent_memory_snapshot_status). Mismatch returns write_conflict without writing."
          ),
      },
      annotations: toolAnnotations("agent_memory_snapshot_sync"),
    },
    async ({ agentId, scope, cwd, direction, retainHistory, expectedHash }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const blocked = cwdOutOfBoundsResult(agentId, resolvedScope, resolvedCwd);
      if (blocked) return blocked;
      const outcome = await syncAgentMemorySnapshot({
        agentId,
        scope: resolvedScope,
        cwd: resolvedCwd,
        direction,
        retainHistory,
        expectedHash,
      });

      if (outcome.status === "write_conflict") {
        return jsonContent({
          status: outcome.status,
          agentId,
          scope: resolvedScope,
          direction: outcome.direction,
          memoryPath: outcome.memoryPath,
          snapshotPath: outcome.snapshotPath,
          targetPath: outcome.targetPath,
          currentHash: outcome.currentHash,
          expectedHash: outcome.expectedHash,
          hint: outcome.hint,
        });
      }

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        direction: outcome.direction,
        memoryPath: outcome.memoryPath,
        snapshotPath: outcome.snapshotPath,
        metaPath: outcome.metaPath,
        snapshotsDir: outcome.snapshotsDir,
        historyEntryId: outcome.historyEntryId,
        meta: outcome.meta,
      });
    }
  );

  server.registerTool(
    "agent_memory_mark_superseded",
    {
      description:
        "Mark memory entries as superseded by abstracted rules. Entries are annotated in place — never deleted — and remain recoverable in MEMORY.md (and via agent_memory_get with includeSuperseded). Pass expectedHash for a compare-and-swap write: on mismatch nothing is written and a write_conflict is returned.",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent identifier"),
        entryIds: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Entry ids (from emitAgentMemoryCompactionPrompt / compose-supervisor-prompts) to mark superseded"
          ),
        supersededBy: z
          .string()
          .min(1)
          .describe("Reference to what replaced the entries (e.g. the compactionId)"),
        scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional project root for project/local scope; must lie under the server launch directory unless XX_STACK_ALLOW_ANY_CWD=1"
          ),
        expectedHash: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional precondition on MEMORY.md (memoryHash from agent_memory_snapshot_status). Mismatch returns write_conflict without writing."
          ),
      },
      annotations: toolAnnotations("agent_memory_mark_superseded"),
    },
    async ({ agentId, entryIds, supersededBy, scope, cwd, expectedHash }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const blocked = cwdOutOfBoundsResult(agentId, resolvedScope, resolvedCwd);
      if (blocked) return blocked;
      const outcome = await markAgentMemorySupersededOnDisk({
        agentId,
        scope: resolvedScope,
        cwd: resolvedCwd,
        entryIds,
        supersededBy,
        expectedHash,
      });

      if (outcome.status === "write_conflict") {
        return jsonContent({
          status: outcome.status,
          agentId,
          scope: resolvedScope,
          path: outcome.path,
          supersededBy: outcome.supersededBy,
          currentHash: outcome.currentHash,
          expectedHash: outcome.expectedHash,
          hint: outcome.hint,
        });
      }

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path: outcome.path,
        supersededBy: outcome.supersededBy,
        marked: outcome.marked,
        alreadySuperseded: outcome.alreadySuperseded,
        missing: outcome.missing,
      });
    }
  );
}
