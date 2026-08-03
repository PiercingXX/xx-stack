import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadMergedAgentRuntimeConfig } from "./config_runtime.js";
import { atomicWriteTextFile } from "./io_runtime.js";
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
import { jsonContent, resolveAgentContext } from "./agent_tool_helpers.js";

export function registerAgentMemoryTools(server: McpServer): void {
  server.tool(
    "agent_memory_get",
    "Read persistent memory entrypoint for an agent and scope. When tokenBudget is set, entries are fitted to the budget via submodular selection (relevant to the optional query + diverse, stable original order).",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
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
    async ({ agentId, scope, cwd, tokenBudget, query, includeSuperseded }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      await ensureMemoryEntrypoint(path);
      const content = await readMemoryEntrypoint(path);

      if (tokenBudget === undefined) {
        // Default path: byte-identical to the pre-tokenBudget behavior.
        return jsonContent({
          status: "ok",
          agentId,
          scope: resolvedScope,
          path,
          content,
        });
      }

      const recall = selectMemoryForBudget(content, tokenBudget, query, includeSuperseded === true);
      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path,
        content: recall.content,
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

  server.tool(
    "agent_memory_append",
    "Append a timestamped memory note for an agent and scope",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      note: z.string().min(1).max(8000).describe("Memory note content"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
    },
    async ({ agentId, note, scope, cwd }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      await ensureMemoryEntrypoint(path);
      const current = await readMemoryEntrypoint(path);
      const entry = `- ${new Date().toISOString()} ${note.trim()}\n`;
      await atomicWriteTextFile(path, `${current}${entry}`);

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path,
        appended: entry.trim(),
      });
    }
  );

  server.tool(
    "agent_memory_snapshot_status",
    "Check whether agent memory and snapshot are in sync and report drift",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
    },
    async ({ agentId, scope, cwd }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const memoryPath = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      const snapshotPath = getAgentMemorySnapshotPath(agentId, resolvedScope, resolvedCwd);
      const metaPath = getAgentMemorySnapshotMetaPath(agentId, resolvedScope, resolvedCwd);

      await ensureMemoryEntrypoint(memoryPath);
      const memoryContent = await readMemoryEntrypoint(memoryPath);
      const snapshotContent = await readMemoryEntrypoint(snapshotPath);
      const meta = await readSnapshotMeta(metaPath);

      const memoryHash = hashMemoryContent(memoryContent);
      const snapshotHash = hashMemoryContent(snapshotContent);
      const diff = lineDiffSummary(snapshotContent, memoryContent);
      const lastSyncedMemoryHash =
        typeof meta?.lastSyncedMemoryHash === "string" ? meta.lastSyncedMemoryHash : null;
      const driftDetected = memoryHash !== snapshotHash;
      const helperPrompt = driftDetected
        ? buildMemoryResyncHelperPrompt(agentId, resolvedScope, diff)
        : null;

      return jsonContent({
        status: driftDetected ? "drifted" : "synced",
        agentId,
        scope: resolvedScope,
        memoryPath,
        snapshotPath,
        metaPath,
        memoryHash,
        snapshotHash,
        lastSyncedMemoryHash,
        driftDetected,
        diff,
        helperPrompt,
      });
    }
  );

  server.tool(
    "agent_memory_snapshot_sync",
    "Sync memory snapshots by capturing current memory or applying snapshot back to live memory. Pass expectedHash (from agent_memory_snapshot_status) for a compare-and-swap write: on mismatch nothing is written and a write_conflict is returned.",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
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
    async ({ agentId, scope, cwd, direction, retainHistory, expectedHash }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
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

  server.tool(
    "agent_memory_compaction_prompt",
    "Emit a deterministic distillation prompt plus candidate memory entries for rule abstraction. The server never calls models: the agent produces the rules, writes them back via agent_memory_append, then marks the sources via agent_memory_mark_superseded.",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
      maxEntries: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional cap on how many oldest non-superseded entries to distill"),
    },
    async ({ agentId, scope, cwd, maxEntries }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
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
  );

  server.tool(
    "agent_memory_mark_superseded",
    "Mark memory entries as superseded by abstracted rules. Entries are annotated in place — never deleted — and remain recoverable in MEMORY.md (and via agent_memory_get with includeSuperseded). Pass expectedHash for a compare-and-swap write: on mismatch nothing is written and a write_conflict is returned.",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      entryIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Entry ids (from agent_memory_compaction_prompt) to mark superseded"),
      supersededBy: z
        .string()
        .min(1)
        .describe("Reference to what replaced the entries (e.g. the compactionId)"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
      expectedHash: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional precondition on MEMORY.md (memoryHash from agent_memory_snapshot_status). Mismatch returns write_conflict without writing."
        ),
    },
    async ({ agentId, entryIds, supersededBy, scope, cwd, expectedHash }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
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
