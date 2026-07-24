import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadMergedAgentRuntimeConfig } from "./config_runtime.js";
import { atomicWriteTextFile } from "./io_runtime.js";
import {
  buildMemoryResyncHelperPrompt,
  ensureMemoryEntrypoint,
  getAgentMemoryEntrypoint,
  getAgentMemorySnapshotMetaPath,
  getAgentMemorySnapshotPath,
  getAgentMemorySnapshotsDir,
  hashMemoryContent,
  lineDiffSummary,
  readMemoryEntrypoint,
  readSnapshotMeta,
  writeSnapshotHistoryEntry,
} from "./memory_runtime.js";
import { jsonContent, resolveAgentContext } from "./agent_tool_helpers.js";

export function registerAgentMemoryTools(server: McpServer): void {
  server.tool(
    "agent_memory_get",
    "Read persistent memory entrypoint for an agent and scope",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
      cwd: z.string().optional().describe("Optional project root for project/local scope"),
    },
    async ({ agentId, scope, cwd }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      await ensureMemoryEntrypoint(path);
      const content = await readMemoryEntrypoint(path);

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        path,
        content,
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
    "Sync memory snapshots by capturing current memory or applying snapshot back to live memory",
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
    },
    async ({ agentId, scope, cwd, direction, retainHistory }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const { resolvedScope, resolvedCwd } = resolveAgentContext(agentId, scope, cwd, runtime);
      const resolvedDirection = direction ?? "capture";
      const shouldRetainHistory = retainHistory === true;
      const memoryPath = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
      const snapshotPath = getAgentMemorySnapshotPath(agentId, resolvedScope, resolvedCwd);
      const metaPath = getAgentMemorySnapshotMetaPath(agentId, resolvedScope, resolvedCwd);
      const snapshotsDir = getAgentMemorySnapshotsDir(agentId, resolvedScope, resolvedCwd);

      await ensureMemoryEntrypoint(memoryPath);
      await mkdir(dirname(snapshotPath), { recursive: true });

      const memoryContent = await readMemoryEntrypoint(memoryPath);
      const snapshotContent = await readMemoryEntrypoint(snapshotPath);
      const sourceContent = resolvedDirection === "capture" ? memoryContent : snapshotContent;
      const targetPath = resolvedDirection === "capture" ? snapshotPath : memoryPath;
      await atomicWriteTextFile(
        targetPath,
        sourceContent.length > 0 ? sourceContent : "# Agent Memory\n\n"
      );

      const updatedMemory = await readMemoryEntrypoint(memoryPath);
      const updatedSnapshot = await readMemoryEntrypoint(snapshotPath);
      const meta = {
        agentId,
        scope: resolvedScope,
        direction: resolvedDirection,
        syncedAt: new Date().toISOString(),
        lastSyncedMemoryHash: hashMemoryContent(updatedMemory),
        lastSyncedSnapshotHash: hashMemoryContent(updatedSnapshot),
        historyRetentionEnabled: shouldRetainHistory,
      };
      await atomicWriteTextFile(metaPath, JSON.stringify(meta, null, 2) + "\n");

      let historyEntryId: string | null = null;
      if (shouldRetainHistory) {
        historyEntryId = await writeSnapshotHistoryEntry(
          snapshotsDir,
          resolvedDirection,
          updatedMemory,
          updatedSnapshot,
          meta
        );
      }

      return jsonContent({
        status: "ok",
        agentId,
        scope: resolvedScope,
        direction: resolvedDirection,
        memoryPath,
        snapshotPath,
        metaPath,
        snapshotsDir: shouldRetainHistory ? snapshotsDir : null,
        historyEntryId,
        meta,
      });
    }
  );
}
