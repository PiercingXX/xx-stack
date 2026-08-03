import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ContextCandidate, estimateTokens, selectContext } from "./context_selection_runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoMapFile {
  path: string;
  score: number;
  ranges: Array<{ startLine: number; endLine: number }>;
  symbols?: string[];
}

export interface RepoMapResult {
  files: RepoMapFile[];
  tokensEstimated: number;
  method: "heuristic" | "treesitter";
}

export interface BuildRepoMapOptions {
  root: string;
  tokenBudget?: number;
  focusPaths?: string[];
  includeSymbols?: boolean;
}

// ---------------------------------------------------------------------------
// Ignore-file helpers
// ---------------------------------------------------------------------------

function parseIgnoreFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const patterns: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

function loadIgnorePatterns(root: string): string[] {
  const patterns: string[] = [];
  // Always exclude .git directory
  patterns.push(".git/");
  for (const name of [".xxignore", ".gitignore"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      patterns.push(...parseIgnoreFile(p));
    }
  }
  return patterns;
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const anchored = pattern.startsWith("/");
    const p = anchored ? pattern.slice(1) : pattern;
    const dirOnly = p.endsWith("/");
    const base = dirOnly ? p.slice(0, -1) : p;

    if (matchGlobLike(relPath, base, anchored)) return true;
    if (dirOnly && relPath.startsWith(base + "/")) return true;
  }
  return false;
}

function matchGlobLike(path: string, pattern: string, anchored: boolean): boolean {
  if (pattern === "**") return true;

  if (pattern.startsWith("**/")) {
    const rest = pattern.slice(3);
    let p = path;
    for (;;) {
      if (simpleMatch(p, rest)) return true;
      const idx = p.indexOf("/");
      if (idx < 0) break;
      p = p.slice(idx + 1);
    }
    return false;
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/");
  }

  if (anchored) {
    return simpleMatch(path, pattern);
  }

  if (simpleMatch(path, pattern)) return true;
  const basename = path.split("/").pop() ?? path;
  if (simpleMatch(basename, pattern)) return true;

  return false;
}

function simpleMatch(path: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return path === pattern;
  }

  // Escape regex special characters except * and ?
  const special = /[.+^${}()|[\]\\-]/g;
  const escaped = pattern.replace(special, "\\$&");
  // Then turn * and ? into regex tokens
  const regexStr = "^" + escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$";
  try {
    return new RegExp(regexStr).test(path);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File discovery (via git ls-files)
// ---------------------------------------------------------------------------

/**
 * Get all tracked files in a git repo, respecting ignore patterns.
 * Uses `git ls-files` for speed and correctness.
 *
 * `-z` is not optional. Without it `git ls-files` applies C quoting to any
 * path containing a double quote, a backslash, a control character, or a
 * non-ASCII byte, emitting `"quote\".ts"` or `"caf\303\251.ts"` — a string
 * that does not name a real file. Those paths then failed every subsequent
 * `readFileSync`/`git log` and were silently dropped from the repo map, so a
 * repo with non-ASCII filenames had holes in it that nothing reported. With
 * `-z` git emits raw NUL-terminated paths and quoting never applies.
 */
async function discoverFiles(root: string, ignorePatterns: string[]): Promise<string[]> {
  let output: string;
  try {
    output = execSync("git ls-files -z --cached --others --exclude-standard", {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Not a git repo or git unavailable — fall back to filesystem walk
    return discoverFilesByWalk(root, ignorePatterns);
  }

  // NUL-separated, so a filename may legally contain a newline.
  const allFiles = output.split("\0").filter(Boolean);
  // Filter through our ignore patterns (git's --exclude-standard already
  // handles .gitignore, but we also need .xxignore)
  return allFiles.filter((f) => !isIgnored(f, ignorePatterns));
}

/**
 * Fallback: walk the filesystem to discover files.
 * Used when git is not available.
 */
async function discoverFilesByWalk(root: string, ignorePatterns: string[]): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      if (isIgnored(relPath, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }

  await walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Scoring signals
// ---------------------------------------------------------------------------

interface FileSignals {
  path: string;
  gitTimestamp: number;
  proximityScore: number;
  refCount: number;
}

function getGitTimestamp(filePath: string, cwd: string): number {
  try {
    const rel = relative(cwd, filePath);
    // execFileSync with an argv array, never a shell string: `rel` is a
    // repo-controlled filename, and a tracked file named with a quote or
    // `$( )` would otherwise execute arbitrary shell during a repo map.
    // The `|| echo 0` shell fallback the old command carried is replaced by
    // the catch below, which already returns 0 on any git failure.
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", rel], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ts = parseInt(out.trim(), 10);
    return Number.isFinite(ts) ? ts * 1000 : 0;
  } catch {
    return 0;
  }
}

function countReferences(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf8");
    const importPatterns = [/(?:import|export)\s+/g, /require\s*\(/g, /from\s+['"]/g];
    let count = 0;
    for (const re of importPatterns) {
      const matches = content.match(re);
      if (matches) count += matches.length;
    }
    return count;
  } catch {
    return 0;
  }
}

function computeProximityScore(relPath: string, focusPaths: string[]): number {
  if (focusPaths.length === 0) return 0;

  let maxScore = 0;
  for (const fp of focusPaths) {
    const normalizedFp = fp.replace(/\/$/, "");
    if (relPath === normalizedFp || relPath.startsWith(normalizedFp + "/")) {
      const depth = relPath.slice(normalizedFp.length).split("/").filter(Boolean).length;
      maxScore = Math.max(maxScore, 1 / (1 + depth));
    } else {
      const commonLen = commonPrefixLength(relPath, normalizedFp);
      if (commonLen > 0) {
        maxScore = Math.max(maxScore, commonLen / Math.max(relPath.length, normalizedFp.length));
      }
    }
  }
  return maxScore;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildRepoMap(options: BuildRepoMapOptions): Promise<RepoMapResult> {
  const { root, tokenBudget = 8000, focusPaths = [], includeSymbols = false } = options;

  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Repo root not found: ${resolvedRoot}`);
  }

  const ignorePatterns = loadIgnorePatterns(resolvedRoot);
  const allFiles = await discoverFiles(resolvedRoot, ignorePatterns);
  if (allFiles.length === 0) {
    return { files: [], tokensEstimated: 0, method: "heuristic" };
  }

  const signals: FileSignals[] = [];
  for (const relPath of allFiles) {
    const fullPath = join(resolvedRoot, relPath);
    const gitTimestamp = getGitTimestamp(fullPath, resolvedRoot);
    const proximityScore = computeProximityScore(relPath, focusPaths);
    const refCount = countReferences(fullPath);
    signals.push({ path: relPath, gitTimestamp, proximityScore, refCount });
  }

  const maxTs = Math.max(...signals.map((s) => s.gitTimestamp), 1);
  const maxRef = Math.max(...signals.map((s) => s.refCount), 1);

  for (const s of signals) {
    const recency = s.gitTimestamp / maxTs;
    const refNorm = s.refCount / maxRef;
    const focus = s.proximityScore;
    s.proximityScore = recency * 0.3 + refNorm * 0.3 + focus * 0.4;
  }

  signals.sort((a, b) => b.proximityScore - a.proximityScore);

  // -------------------------------------------------------------------------
  // Budget fitting via submodular context selection (context_selection_runtime).
  // The heuristic score above stays the relevance signal; coverage/diversity
  // come from cheap lexical similarity over file contents. minGain is
  // -Infinity so the repo-map contract is unchanged: fill the budget rather
  // than stop at the first non-positive marginal gain.
  // -------------------------------------------------------------------------

  const contents = new Map<string, string>();
  const candidates: ContextCandidate[] = [];
  for (const s of signals) {
    const fullPath = join(resolvedRoot, s.path);
    let fileContent = "";
    try {
      fileContent = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (fileContent.length === 0) continue;
    contents.set(s.path, fileContent);
    candidates.push({
      id: s.path,
      text: fileContent,
      tokens: estimateTokens(fileContent),
      relevance: s.proximityScore,
    });
  }

  const selection = selectContext({
    candidates,
    tokenBudget,
    minGain: Number.NEGATIVE_INFINITY,
    weights: { relevance: 2, coverage: 1, diversity: 1 },
  });
  const chosen = new Set(selection.selected.map((item) => item.id));

  // Preserve the existing output contract: files ordered by heuristic score.
  const selected: RepoMapFile[] = [];
  let runningTokens = selection.tokensEstimated;

  for (const s of signals) {
    if (!chosen.has(s.path)) continue;
    const fileContent = contents.get(s.path) ?? "";

    let symbols: string[] | undefined;
    if (includeSymbols) {
      symbols = extractSymbols(fileContent);
    }

    selected.push({
      path: s.path,
      score: s.proximityScore,
      ranges: [{ startLine: 1, endLine: fileContent.split("\n").length }],
      symbols,
    });
  }

  // Existing contract: when budget remains but the best-ranked unselected
  // file is too large to fit whole, include a truncated head of it.
  const remaining = tokenBudget - runningTokens;
  if (remaining > 0) {
    const next = signals.find((s) => !chosen.has(s.path) && contents.has(s.path));
    if (next) {
      const fileContent = contents.get(next.path) ?? "";
      const lines = fileContent.split("\n");
      // Take whole lines while they fit the remaining token budget
      // (~4 chars per token), so tokensEstimated never exceeds tokenBudget.
      const charBudget = remaining * 4;
      let usedChars = 0;
      let lineBudget = 0;
      for (const line of lines) {
        const lineChars = line.length + (lineBudget > 0 ? 1 : 0); // +1 for "\n"
        if (usedChars + lineChars > charBudget) break;
        usedChars += lineChars;
        lineBudget += 1;
      }

      if (lineBudget > 0) {
        const truncatedContent = lines.slice(0, lineBudget).join("\n");
        const truncatedTokens = estimateTokens(truncatedContent);

        let symbols: string[] | undefined;
        if (includeSymbols) {
          symbols = extractSymbols(truncatedContent);
        }

        selected.push({
          path: next.path,
          score: next.proximityScore,
          ranges: [{ startLine: 1, endLine: lineBudget }],
          symbols,
        });

        runningTokens += truncatedTokens;
      }
    }
  }

  return {
    files: selected,
    tokensEstimated: runningTokens,
    method: "heuristic",
  };
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s+)?\(/g,
    /(?:export\s+)?interface\s+(\w+)/g,
    /(?:export\s+)?type\s+(\w+)\s*=/g,
    /(?:export\s+)?enum\s+(\w+)/g,
    /def\s+(\w+)\s*\(/g,
    /class\s+(\w+)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      symbols.push(m[1]);
    }
  }
  return [...new Set(symbols)];
}
