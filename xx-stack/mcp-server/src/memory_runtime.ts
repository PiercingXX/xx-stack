import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { AgentMemoryScope, readJson } from "./config_runtime.js";
import { estimateTokens, selectContext } from "./context_selection_runtime.js";
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

/**
 * Reduce an agent id or project path to one safe path segment.
 *
 * The character class keeps `.` so ordinary names like `reviewer.v2` survive,
 * but that also let the dot-only segments `.` and `..` through untouched — and
 * an agentId of `..` resolves one directory ABOVE the scoped memory dir, so
 * MEMORY.md lands outside the scope the caller asked for. Dot-only results are
 * therefore replaced outright; nothing else changes.
 */
export function sanitizeNameForPath(value: string): string {
  const collapsed = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  if (collapsed.length === 0 || /^\.+$/.test(collapsed)) return "_";
  return collapsed;
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

/** The bytes ensureMemoryEntrypoint writes into an absent memory file. */
export const DEFAULT_MEMORY_TEMPLATE = "# Agent Memory\n\n";

/**
 * Create the memory file with its header if it is not there yet.
 *
 * `wx` — create exclusively, never truncate. The previous read-then-replace
 * shape raced every concurrent append: N callers all observe an absent file,
 * and the last atomic replace renames the template over entries another caller
 * had already appended. Losing to EEXIST is the success case here.
 */
export async function ensureMemoryEntrypoint(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, DEFAULT_MEMORY_TEMPLATE, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EEXIST") throw error;
  }
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export async function readSnapshotMeta(path: string): Promise<Record<string, unknown> | null> {
  return readJson(path);
}

/**
 * Line-level added/removed/changed counts, derived from the LCS *length*.
 *
 * Only the final LCS length is consumed, never a traceback, so the DP keeps two
 * rolling rows instead of the full (rows+1)x(cols+1) matrix. MEMORY.md is
 * append-only and never trimmed: at ~10k lines a side the full matrix is ~10^8
 * numbers (gigabytes), allocated inside a ~2.5s `_Stop` hook budget. Memory is
 * now O(min(rows, cols)); the returned numbers are unchanged.
 */
export function lineDiffSummary(previousContent: string, nextContent: string): MemoryDiffSummary {
  const previous = previousContent.split(/\r?\n/);
  const next = nextContent.split(/\r?\n/);
  const rows = previous.length;
  const cols = next.length;

  // Iterate over the longer sequence so the rolling rows are the shorter one.
  const [outer, inner] = rows >= cols ? [previous, next] : [next, previous];
  const innerLength = inner.length;

  let prevRow = new Array<number>(innerLength + 1).fill(0);
  let curRow = new Array<number>(innerLength + 1).fill(0);

  for (let i = 1; i <= outer.length; i += 1) {
    const outerLine = outer[i - 1];
    curRow[0] = 0;
    for (let j = 1; j <= innerLength; j += 1) {
      if (outerLine === inner[j - 1]) {
        curRow[j] = prevRow[j - 1] + 1;
      } else {
        const up = prevRow[j];
        const left = curRow[j - 1];
        curRow[j] = up >= left ? up : left;
      }
    }
    const swap = prevRow;
    prevRow = curRow;
    curRow = swap;
  }

  const lcs = prevRow[innerLength];
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
    "After syncing, run agent_memory_get again and confirm snapshot.driftDetected=false.",
  ].join(" ");
}

/**
 * Write one `.snapshots/` history entry (memory, snapshot, meta) and return its
 * base name. Two entries written in the same millisecond would collide on the
 * timestamp-derived base and silently overwrite each other's history, so a
 * colliding base gets a short random suffix — every entry keeps its own files.
 *
 * `now` is injectable so a test can force the collision deterministically.
 */
export async function writeSnapshotHistoryEntry(
  snapshotsDir: string,
  direction: "capture" | "apply",
  memoryContent: string,
  snapshotContent: string,
  meta: Record<string, unknown>,
  now: Date = new Date()
): Promise<string> {
  await mkdir(snapshotsDir, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  let base = `${timestamp}-${direction}`;
  while (historyEntryExists(snapshotsDir, base)) {
    base = `${base}-${randomBytes(3).toString("hex")}`;
  }
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

function historyEntryExists(snapshotsDir: string, base: string): boolean {
  return (
    existsSync(resolve(snapshotsDir, `${base}-MEMORY.md`)) ||
    existsSync(resolve(snapshotsDir, `${base}-SNAPSHOT.md`)) ||
    existsSync(resolve(snapshotsDir, `${base}-meta.json`))
  );
}

export interface CompletionMemorySyncStatusOptions {
  /**
   * Create MEMORY.md/SNAPSHOT.md (and their directory) when absent. Defaults to
   * true for the completion gate, which wants the scaffolding in place. Read-only
   * callers — notably the `_Stop` hook, whose contract is "two file reads, no
   * filesystem walks" — must pass false: an mkdir + atomic write from a status
   * check is a side effect on a read path.
   */
  ensureFiles?: boolean;
}

export async function getCompletionMemorySyncStatus(
  guard: CompletionMemorySyncGuard,
  options: CompletionMemorySyncStatusOptions = {}
): Promise<CompletionMemorySyncStatus> {
  const memoryPath = getAgentMemoryEntrypoint(guard.agentId, guard.scope, guard.cwd);
  const snapshotPath = getAgentMemorySnapshotPath(guard.agentId, guard.scope, guard.cwd);
  const metaPath = getAgentMemorySnapshotMetaPath(guard.agentId, guard.scope, guard.cwd);

  if (options.ensureFiles !== false) {
    await ensureMemoryEntrypoint(memoryPath);
    await ensureMemoryEntrypoint(snapshotPath);
  }

  // Without the scaffolding writes an absent file reads as "", where the
  // ensuring path would have read back the template. Substituting the template
  // here keeps both modes byte-identical in what they report.
  const orDefault = (content: string): string =>
    content.length === 0 ? DEFAULT_MEMORY_TEMPLATE : content;
  const memoryContent = orDefault(await readMemoryEntrypoint(memoryPath));
  const snapshotContent = orDefault(await readMemoryEntrypoint(snapshotPath));

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

// ---------------------------------------------------------------------------
// Memory entry parsing
// ---------------------------------------------------------------------------

const SUPERSEDED_MARKER_RE = /^- \[superseded:([^\]]*)\] ?(.*)$/;

export interface ParsedMemoryEntry {
  /** Stable identifier: hash of the entry text with any superseded marker
   * stripped, so the id survives being marked superseded. */
  id: string;
  /** Position of the entry in the document (0-based). */
  index: number;
  /** 0-based line number of the entry's bullet line in the raw content. */
  line: number;
  /** Full entry text as it appears in the file (marker included if present). */
  text: string;
  /** Entry text with any superseded marker stripped ("- " prefix retained). */
  canonicalText: string;
  superseded: boolean;
  supersededBy: string | null;
}

export interface ParsedMemoryDocument {
  /** Raw content before the first entry (headers etc.), verbatim. */
  preamble: string;
  entries: ParsedMemoryEntry[];
}

/** Stable id for a memory entry line (superseded marker ignored). */
export function computeMemoryEntryId(entryText: string): string {
  const match = SUPERSEDED_MARKER_RE.exec(entryText);
  const canonical = match ? `- ${match[2]}` : entryText;
  return hashMemoryContent(canonical);
}

/**
 * Parse a MEMORY.md document into a preamble plus bullet entries. An entry is
 * a line starting with "- " at column 0 (the shape agent_memory_append
 * writes); everything before the first entry is preamble and preserved.
 */
export function parseMemoryEntries(content: string): ParsedMemoryDocument {
  const lines = content.split("\n");
  const entries: ParsedMemoryEntry[] = [];
  let firstEntryLine = -1;

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (!line.startsWith("- ")) continue;
    if (firstEntryLine === -1) firstEntryLine = lineNo;

    const match = SUPERSEDED_MARKER_RE.exec(line);
    const canonicalText = match ? `- ${match[2]}` : line;
    entries.push({
      id: hashMemoryContent(canonicalText),
      index: entries.length,
      line: lineNo,
      text: line,
      canonicalText,
      superseded: match !== null,
      supersededBy: match ? match[1] : null,
    });
  }

  const preamble = firstEntryLine === -1 ? content : lines.slice(0, firstEntryLine).join("\n");
  return { preamble, entries };
}

// ---------------------------------------------------------------------------
// Token-budgeted recall
// ---------------------------------------------------------------------------

export interface BudgetedMemoryRecall {
  /** Preamble plus the selected entries in their original file order. */
  content: string;
  tokenBudget: number;
  tokensEstimated: number;
  entriesTotal: number;
  entriesSelected: number;
  entriesSuperseded: number;
  /** True when anything eligible had to be left out to fit the budget. */
  truncated: boolean;
}

/** Strip the bullet prefix, superseded marker, and leading ISO timestamp so
 * similarity signals compare note content rather than scaffolding. */
function stripEntryScaffolding(entryText: string): string {
  return entryText.replace(/^- (?:\[superseded:[^\]]*\] )?(?:\d{4}-\d{2}-\d{2}T[0-9:.]+Z? )?/, "");
}

/**
 * Fit memory content into a token budget. Entry selection uses submodular
 * context selection (relevant to the optional query + diverse), superseded
 * entries are excluded unless includeSuperseded is set, and the selected
 * entries are returned in stable original order.
 */
export function selectMemoryForBudget(
  content: string,
  tokenBudget: number,
  query?: string,
  includeSuperseded = false
): BudgetedMemoryRecall {
  const doc = parseMemoryEntries(content);
  const supersededCount = doc.entries.filter((e) => e.superseded).length;
  const eligible = includeSuperseded ? doc.entries : doc.entries.filter((e) => !e.superseded);

  const preamble = doc.preamble.replace(/\n+$/, "");
  const preambleBlock = preamble.length > 0 ? `${preamble}\n\n` : "";
  const preambleTokens = estimateTokens(preambleBlock);

  const base: Omit<
    BudgetedMemoryRecall,
    "content" | "tokensEstimated" | "entriesSelected" | "truncated"
  > = {
    tokenBudget,
    entriesTotal: doc.entries.length,
    entriesSuperseded: supersededCount,
  };

  const entryBudget = tokenBudget - preambleTokens;
  if (entryBudget <= 0) {
    // Budget cannot even hold the preamble: return as much of it as fits.
    const charBudget = Math.max(0, tokenBudget * 4);
    const clipped = preambleBlock.slice(0, charBudget);
    return {
      ...base,
      content: clipped,
      tokensEstimated: estimateTokens(clipped),
      entriesSelected: 0,
      truncated: true,
    };
  }

  // Byte-identical entries share an id; keep only the first occurrence so a
  // single selection cannot pull multiple copies past the budget.
  const uniqueEligible: typeof eligible = [];
  const seenIds = new Set<string>();
  for (const e of eligible) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    uniqueEligible.push(e);
  }

  const selection = selectContext({
    candidates: uniqueEligible.map((e) => ({
      id: e.id,
      // Similarity/relevance over the note itself: the bullet prefix, any
      // superseded marker, and the timestamp would otherwise make every
      // entry look alike. Token cost still charges for the full line.
      text: stripEntryScaffolding(e.text),
      // +1 accounts for the newline each entry adds to the assembled content.
      tokens: estimateTokens(e.text) + 1,
    })),
    tokenBudget: entryBudget,
    query,
  });
  const chosen = new Set(selection.selected.map((s) => s.id));

  // Stable order: original file order, not selection order.
  const selectedEntries = uniqueEligible.filter((e) => chosen.has(e.id));
  const body = selectedEntries.map((e) => e.text).join("\n");
  const assembled = `${preambleBlock}${body}${body.length > 0 ? "\n" : ""}`;

  return {
    ...base,
    content: assembled,
    tokensEstimated: estimateTokens(assembled),
    entriesSelected: selectedEntries.length,
    truncated: selectedEntries.length < eligible.length,
  };
}

// ---------------------------------------------------------------------------
// Rule-abstraction compaction (continuation-prompt pattern: the server never
// calls models — it emits a deterministic distillation prompt; the agent
// writes abstracted rules back via agent_memory_append and marks the source
// entries superseded via agent_memory_mark_superseded).
// ---------------------------------------------------------------------------

export interface CompactionCandidate {
  id: string;
  text: string;
}

export interface CompactionPromptResult {
  /** Deterministic id derived from the candidate entry ids. */
  compactionId: string;
  prompt: string;
  candidates: CompactionCandidate[];
  entriesTotal: number;
  entriesEligible: number;
}

/**
 * Build a deterministic distillation prompt from the non-superseded entries
 * of a memory document. Same content in -> byte-identical prompt out.
 */
export function buildMemoryCompactionPrompt(
  agentId: string,
  content: string,
  maxEntries?: number
): CompactionPromptResult {
  const doc = parseMemoryEntries(content);
  const eligible = doc.entries.filter((e) => !e.superseded);
  const limit =
    typeof maxEntries === "number" && maxEntries > 0
      ? Math.min(maxEntries, eligible.length)
      : eligible.length;
  const picked = eligible.slice(0, limit);

  const candidates: CompactionCandidate[] = picked.map((e) => ({ id: e.id, text: e.text }));
  const compactionId = hashMemoryContent(candidates.map((c) => c.id).join(","));

  const lines: string[] = [
    `Memory compaction for agent "${agentId}" (compaction ${compactionId}).`,
    "",
    `Below are ${candidates.length} specific memory entries. Distill them into a small set of general rules:`,
    "1. Each rule must be one sentence stating a durable, reusable lesson — not a restatement of a single observation.",
    "2. Only abstract patterns supported by two or more entries; leave one-off facts alone.",
    "3. Do not invent information that is not in the entries.",
    "",
    "Then apply the compaction:",
    `1. Write each rule back with agent_memory_append (agentId "${agentId}"), prefixing the note with "[rule ${compactionId}]".`,
    `2. Mark the entries you distilled as superseded by calling agent_memory_mark_superseded with supersededBy "${compactionId}" and the entryIds listed below.`,
    "3. Never delete entries: superseded entries stay in MEMORY.md and remain recoverable.",
    "",
    "Candidate entries (entryId: text):",
    ...candidates.map((c) => `${c.id}: ${c.text}`),
  ];

  return {
    compactionId,
    prompt: lines.join("\n"),
    candidates,
    entriesTotal: doc.entries.length,
    entriesEligible: eligible.length,
  };
}

export interface MarkSupersededResult {
  content: string;
  marked: string[];
  alreadySuperseded: string[];
  missing: string[];
}

/**
 * Mark entries superseded in place. Only the matched bullet lines change
 * (a "[superseded:<ref>]" marker is inserted after "- "); every other byte of
 * the document is preserved, so the original observations stay recoverable.
 */
export function markMemoryEntriesSuperseded(
  content: string,
  entryIds: string[],
  supersededBy: string
): MarkSupersededResult {
  const doc = parseMemoryEntries(content);
  const lines = content.split("\n");
  const wanted = new Set(entryIds);
  const marked: string[] = [];
  const alreadySuperseded: string[] = [];
  const found = new Set<string>();

  for (const entry of doc.entries) {
    if (!wanted.has(entry.id)) continue;
    found.add(entry.id);
    if (entry.superseded) {
      alreadySuperseded.push(entry.id);
      continue;
    }
    lines[entry.line] = `- [superseded:${supersededBy}] ${entry.text.slice(2)}`;
    marked.push(entry.id);
  }

  const missing = entryIds.filter((id) => !found.has(id));
  return { content: lines.join("\n"), marked, alreadySuperseded, missing };
}

// ---------------------------------------------------------------------------
// Compare-and-swap writes
//
// Concurrent agents share one memory scope, and both write paths below are
// read-modify-write over the same file. An optional expectedHash (obtained
// from a prior get/status call, hashed with hashMemoryContent) acts as a
// precondition on the exact bytes the write would clobber. On mismatch the
// call returns a structured write_conflict and writes nothing: the caller
// re-reads, merges, and retries. The server never merges, never locks, and
// keeps no extra state. Omitting expectedHash is byte-identical to the
// pre-task-29 behavior.
// ---------------------------------------------------------------------------

export const MEMORY_WRITE_CONFLICT_HINT = "re-read and retry";

export interface MemoryWriteConflict {
  status: "write_conflict";
  /** Hash of the target file as it actually is right now. */
  currentHash: string;
  /** Hash the caller asserted the target file would still have. */
  expectedHash: string;
  hint: string;
}

/**
 * Evaluate an optimistic-concurrency precondition. Returns null when there is
 * no precondition (expectedHash omitted) or when it holds; otherwise the
 * structured conflict the caller should surface instead of writing.
 */
export function detectMemoryWriteConflict(
  currentContent: string,
  expectedHash?: string
): MemoryWriteConflict | null {
  if (expectedHash === undefined) return null;
  const currentHash = hashMemoryContent(currentContent);
  if (currentHash === expectedHash) return null;
  return {
    status: "write_conflict",
    currentHash,
    expectedHash,
    hint: MEMORY_WRITE_CONFLICT_HINT,
  };
}

export interface AgentMemoryTarget {
  agentId: string;
  scope: AgentMemoryScope;
  cwd: string;
}

export interface SnapshotSyncRequest extends AgentMemoryTarget {
  direction?: "capture" | "apply";
  retainHistory?: boolean;
  /**
   * Precondition on the file this sync would overwrite: MEMORY.md for
   * direction "apply", SNAPSHOT.md for direction "capture". Both hashes are
   * reported by agent_memory_snapshot_status.
   */
  expectedHash?: string;
}

export interface SnapshotSyncOk {
  status: "ok";
  direction: "capture" | "apply";
  memoryPath: string;
  snapshotPath: string;
  metaPath: string;
  snapshotsDir: string | null;
  historyEntryId: string | null;
  meta: Record<string, unknown>;
}

export interface SnapshotSyncConflict extends MemoryWriteConflict {
  direction: "capture" | "apply";
  memoryPath: string;
  snapshotPath: string;
  /** The file the write would have clobbered. */
  targetPath: string;
}

export type SnapshotSyncOutcome = SnapshotSyncOk | SnapshotSyncConflict;

/**
 * Snapshot sync (capture: memory -> snapshot; apply: snapshot -> memory).
 * Shared by the agent_memory_snapshot_sync MCP tool and the xx CLI so neither
 * forks the orchestration.
 */
export async function syncAgentMemorySnapshot(
  request: SnapshotSyncRequest
): Promise<SnapshotSyncOutcome> {
  const { agentId, scope, cwd } = request;
  const direction = request.direction ?? "capture";
  const shouldRetainHistory = request.retainHistory === true;
  const memoryPath = getAgentMemoryEntrypoint(agentId, scope, cwd);
  const snapshotPath = getAgentMemorySnapshotPath(agentId, scope, cwd);
  const metaPath = getAgentMemorySnapshotMetaPath(agentId, scope, cwd);
  const snapshotsDir = getAgentMemorySnapshotsDir(agentId, scope, cwd);

  await ensureMemoryEntrypoint(memoryPath);
  await mkdir(dirname(snapshotPath), { recursive: true });

  const memoryContent = await readMemoryEntrypoint(memoryPath);
  const snapshotContent = await readMemoryEntrypoint(snapshotPath);
  const sourceContent = direction === "capture" ? memoryContent : snapshotContent;
  const targetPath = direction === "capture" ? snapshotPath : memoryPath;
  const targetContent = direction === "capture" ? snapshotContent : memoryContent;

  const conflict = detectMemoryWriteConflict(targetContent, request.expectedHash);
  if (conflict) {
    // Nothing has been written: the entrypoint scaffolding above is the same
    // read-path guarantee agent_memory_get already makes.
    return { ...conflict, direction, memoryPath, snapshotPath, targetPath };
  }

  await atomicWriteTextFile(
    targetPath,
    sourceContent.length > 0 ? sourceContent : "# Agent Memory\n\n"
  );

  const updatedMemory = await readMemoryEntrypoint(memoryPath);
  const updatedSnapshot = await readMemoryEntrypoint(snapshotPath);
  const meta = {
    agentId,
    scope,
    direction,
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
      direction,
      updatedMemory,
      updatedSnapshot,
      meta
    );
  }

  return {
    status: "ok",
    direction,
    memoryPath,
    snapshotPath,
    metaPath,
    snapshotsDir: shouldRetainHistory ? snapshotsDir : null,
    historyEntryId,
    meta,
  };
}

export interface MarkSupersededRequest extends AgentMemoryTarget {
  entryIds: string[];
  supersededBy: string;
  /** Precondition on MEMORY.md, the file marking rewrites in place. */
  expectedHash?: string;
}

export interface MarkSupersededOk {
  status: "ok";
  path: string;
  supersededBy: string;
  marked: string[];
  alreadySuperseded: string[];
  missing: string[];
}

export interface MarkSupersededConflict extends MemoryWriteConflict {
  path: string;
  supersededBy: string;
}

export type MarkSupersededOutcome = MarkSupersededOk | MarkSupersededConflict;

/**
 * Mark entries superseded on disk. Shared by the agent_memory_mark_superseded
 * MCP tool and the xx CLI.
 */
export async function markAgentMemorySupersededOnDisk(
  request: MarkSupersededRequest
): Promise<MarkSupersededOutcome> {
  const { agentId, scope, cwd, entryIds, supersededBy } = request;
  const path = getAgentMemoryEntrypoint(agentId, scope, cwd);
  await ensureMemoryEntrypoint(path);
  const content = await readMemoryEntrypoint(path);

  const conflict = detectMemoryWriteConflict(content, request.expectedHash);
  if (conflict) {
    return { ...conflict, path, supersededBy };
  }

  const result = markMemoryEntriesSuperseded(content, entryIds, supersededBy);
  if (result.marked.length > 0) {
    await atomicWriteTextFile(path, result.content);
  }

  return {
    status: "ok",
    path,
    supersededBy,
    marked: result.marked,
    alreadySuperseded: result.alreadySuperseded,
    missing: result.missing,
  };
}
