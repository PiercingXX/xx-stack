import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

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
    while (true) {
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
 */
async function discoverFiles(
  root: string,
  ignorePatterns: string[]
): Promise<string[]> {
  let output: string;
  try {
    output = execSync(
      "git ls-files --cached --others --exclude-standard",
      { cwd: root, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    // Not a git repo or git unavailable — fall back to filesystem walk
    return discoverFilesByWalk(root, ignorePatterns);
  }

  const allFiles = output.trim().split("\n").filter(Boolean);
  // Filter through our ignore patterns (git's --exclude-standard already
  // handles .gitignore, but we also need .xxignore)
  return allFiles.filter((f) => !isIgnored(f, ignorePatterns));
}

/**
 * Fallback: walk the filesystem to discover files.
 * Used when git is not available.
 */
async function discoverFilesByWalk(
  root: string,
  ignorePatterns: string[]
): Promise<string[]> {
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
    const out = execSync(
      `git log -1 --format=%ct -- "${rel}" 2>/dev/null || echo "0"`,
      { cwd, encoding: "utf8", timeout: 5000 }
    );
    const ts = parseInt(out.trim(), 10);
    return Number.isFinite(ts) ? ts * 1000 : 0;
  } catch {
    return 0;
  }
}

function countReferences(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf8");
    const importPatterns = [
      /(?:import|export)\s+/g,
      /require\s*\(/g,
      /from\s+['"]/g,
    ];
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
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  const selected: RepoMapFile[] = [];
  let runningTokens = 0;

  for (const s of signals) {
    const fullPath = join(resolvedRoot, s.path);
    let fileContent = "";
    let fileTokens = 0;
    try {
      fileContent = readFileSync(fullPath, "utf8");
      fileTokens = estimateTokens(fileContent);
    } catch {
      fileTokens = 0;
    }

    if (fileTokens === 0) continue;

    // If this file alone exceeds the remaining budget, include a truncated range
    const remaining = tokenBudget - runningTokens;
    if (runningTokens + fileTokens > tokenBudget) {
      if (remaining <= 0) break;

      // Truncate the file to fit within remaining budget
      const lines = fileContent.split("\n");
      const totalLines = lines.length;
      // Estimate how many lines fit: proportional to token ratio
      const lineBudget = Math.max(1, Math.floor((remaining / fileTokens) * totalLines));
      const truncatedContent = lines.slice(0, lineBudget).join("\n");
      const truncatedTokens = estimateTokens(truncatedContent);

      const ranges = [{ startLine: 1, endLine: lineBudget }];

      let symbols: string[] | undefined;
      if (includeSymbols) {
        symbols = extractSymbols(truncatedContent);
      }

      selected.push({
        path: s.path,
        score: s.proximityScore,
        ranges,
        symbols,
      });

      runningTokens += truncatedTokens;
      break;
    }

    const ranges = [{ startLine: 1, endLine: fileContent.split("\n").length }];

    let symbols: string[] | undefined;
    if (includeSymbols) {
      symbols = extractSymbols(fileContent);
    }

    selected.push({
      path: s.path,
      score: s.proximityScore,
      ranges,
      symbols,
    });

    runningTokens += fileTokens;
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