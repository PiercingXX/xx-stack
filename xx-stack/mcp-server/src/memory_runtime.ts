import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { AgentMemoryScope, readJson } from "./config_runtime.js";
import { atomicWriteTextFile } from "./io_runtime.js";
import { PATH_CONSTANTS } from "./runtime_constants.js";

export interface CompletionMemorySyncGuard {
  agentId: string;
  scope: AgentMemoryScope;
  cwd: string;
}

export interface MemoryDiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export interface CompletionMemorySyncStatus {
  memoryPath: string;
  snapshotPath: string;
  metaPath: string;
  memoryHash: string;
  snapshotHash: string;
  driftDetected: boolean;
  diff: MemoryDiffSummary;
  helperPrompt: string | null;
}

export function sanitizeNameForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

function getScopedAgentMemoryDir(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  const safeAgent = sanitizeNameForPath(agentId);
  const safeProject = sanitizeNameForPath(resolve(cwd));
  if (scope === "project") {
    const canonicalDir = resolve(cwd, PATH_CONSTANTS.stateDir, "agent-memory", safeAgent);
    const compatDir = resolve(cwd, PATH_CONSTANTS.compatDir, "agent-memory", safeAgent);
    return existsSync(canonicalDir) || !existsSync(compatDir) ? canonicalDir : compatDir;
  }
  if (scope === "local") {
    return resolve(homedir(), ".config/opencode/agent-memory-local", safeProject, safeAgent);
  }
  return resolve(homedir(), ".config/opencode/agent-memory", safeAgent);
}

export function getAgentMemoryEntrypoint(
  agentId: string,
  scope: AgentMemoryScope,
  cwd: string
): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), "MEMORY.md");
}

export function getAgentMemorySnapshotPath(
  agentId: string,
  scope: AgentMemoryScope,
  cwd: string
): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), "SNAPSHOT.md");
}

export function getAgentMemorySnapshotMetaPath(
  agentId: string,
  scope: AgentMemoryScope,
  cwd: string
): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), ".snapshot-meta.json");
}

export function getAgentMemorySnapshotsDir(
  agentId: string,
  scope: AgentMemoryScope,
  cwd: string
): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), ".snapshots");
}

export async function readMemoryEntrypoint(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function ensureMemoryEntrypoint(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const current = await readMemoryEntrypoint(path);
  if (current.length === 0) {
    await atomicWriteTextFile(path, "# Agent Memory\n\n");
  }
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export async function readSnapshotMeta(path: string): Promise<Record<string, unknown> | null> {
  return readJson(path);
}

export function lineDiffSummary(previousContent: string, nextContent: string): MemoryDiffSummary {
  const previous = previousContent.split(/\r?\n/);
  const next = nextContent.split(/\r?\n/);
  const rows = previous.length;
  const cols = next.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (previous[i - 1] === next[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[rows][cols];
  const added = Math.max(0, cols - lcs);
  const removed = Math.max(0, rows - lcs);
  return {
    added,
    removed,
    changed: Math.min(added, removed),
  };
}

export function buildMemoryResyncHelperPrompt(
  agentId: string,
  scope: AgentMemoryScope,
  drift: MemoryDiffSummary
): string {
  return [
    `Memory drift detected for agent ${agentId} (${scope}).`,
    `Diff summary: added=${drift.added}, removed=${drift.removed}, changed=${drift.changed}.`,
    "If current MEMORY.md is authoritative, run agent_memory_snapshot_sync with direction='capture'.",
    "If SNAPSHOT.md is authoritative, run agent_memory_snapshot_sync with direction='apply'.",
    "After syncing, run agent_memory_snapshot_status again to confirm driftDetected=false.",
  ].join(" ");
}

export async function writeSnapshotHistoryEntry(
  snapshotsDir: string,
  direction: "capture" | "apply",
  memoryContent: string,
  snapshotContent: string,
  meta: Record<string, unknown>
): Promise<string> {
  await mkdir(snapshotsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${timestamp}-${direction}`;
  const memoryHistoryPath = resolve(snapshotsDir, `${base}-MEMORY.md`);
  const snapshotHistoryPath = resolve(snapshotsDir, `${base}-SNAPSHOT.md`);
  const metaHistoryPath = resolve(snapshotsDir, `${base}-meta.json`);
  await atomicWriteTextFile(
    memoryHistoryPath,
    memoryContent.length > 0 ? memoryContent : "# Agent Memory\n\n"
  );
  await atomicWriteTextFile(
    snapshotHistoryPath,
    snapshotContent.length > 0 ? snapshotContent : "# Agent Memory\n\n"
  );
  await atomicWriteTextFile(metaHistoryPath, JSON.stringify(meta, null, 2) + "\n");
  return base;
}

export async function getCompletionMemorySyncStatus(
  guard: CompletionMemorySyncGuard
): Promise<CompletionMemorySyncStatus> {
  const memoryPath = getAgentMemoryEntrypoint(guard.agentId, guard.scope, guard.cwd);
  const snapshotPath = getAgentMemorySnapshotPath(guard.agentId, guard.scope, guard.cwd);
  const metaPath = getAgentMemorySnapshotMetaPath(guard.agentId, guard.scope, guard.cwd);

  await ensureMemoryEntrypoint(memoryPath);
  await ensureMemoryEntrypoint(snapshotPath);

  const memoryContent = await readMemoryEntrypoint(memoryPath);
  const snapshotContent = await readMemoryEntrypoint(snapshotPath);

  const memoryHash = hashMemoryContent(memoryContent);
  const snapshotHash = hashMemoryContent(snapshotContent);
  const driftDetected = memoryHash !== snapshotHash;
  const diff = lineDiffSummary(snapshotContent, memoryContent);
  const helperPrompt = driftDetected
    ? buildMemoryResyncHelperPrompt(guard.agentId, guard.scope, diff)
    : null;

  return {
    memoryPath,
    snapshotPath,
    metaPath,
    memoryHash,
    snapshotHash,
    driftDetected,
    diff,
    helperPrompt,
  };
}
