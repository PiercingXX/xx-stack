import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ContextCandidate, estimateTokens, selectContext } from "./context_selection_runtime.js";
import { loadRegistry } from "./platform_runtime.js";
import type { Registry } from "./platform_types.js";

/**
 * Test seam for the two process-spawning / registry-reading calls this module
 * makes.
 *
 * Both failure paths — a `git log` that fails on an otherwise-usable repo, and
 * a registry that cannot be loaded — are properties of the machine running the
 * suite, not of any fixture, so they are only reachable from a test that can
 * decide the outcome. The spawn count is also the *only* non-timing way to
 * assert that the recency walk is one process and not one per file.
 * Swapped only by `repo_map_runtime.test.ts`; production never reassigns it.
 */
export const __repoMapIo = { execFileSync, loadRegistry };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoMapFile {
  path: string;
  score: number;
  ranges: Array<{ startLine: number; endLine: number }>;
  symbols?: string[];
}

/** One exclusion class: how many paths left the map this way, and a few of them. */
export interface RepoMapOmission {
  count: number;
  /**
   * At most {@link OMISSION_EXAMPLE_LIMIT} paths. Deterministic: every class
   * except `droppedForScale`, `droppedForBudget` and `truncated` keeps the
   * lexicographically first paths, so the sample does not depend on filesystem
   * or `git ls-files` ordering. Those three keep the highest-*ranked* paths
   * instead, because "the next best file you did not get" is the useful sample
   * there and rank order is itself deterministic.
   */
  examples: string[];
}

/**
 * The negative space of the repo map: everything discovery saw and the map does
 * not contain.
 *
 * `repo_map_runtime.ts` used to have a bare `catch { continue; }` and reported
 * nothing, which is how two separate causes of the same symptom — files
 * missing from the map with nothing saying so — both shipped. The first was
 * `git ls-files` C-quoting (fixed with `-z`, see `discoverFiles`); the cause
 * was fixed and the *reporting* was not, so the next cause (unreadable,
 * oversized, and binary files) reproduced the same invisible holes.
 *
 * Read this as a lower bound, not a ledger. It reports the exclusions this
 * module makes; it cannot report a file that never reached discovery at all
 * (an unreadable parent directory in the walk fallback, a path `git ls-files`
 * does not emit). The absence of an omission is not a completeness guarantee.
 */
export interface RepoMapOmissions {
  /**
   * Paths discovery produced, before this module's ignore filtering. Exact for
   * the `git ls-files` path. For the filesystem-walk fallback a pruned
   * directory counts as one entry, not as the files beneath it.
   */
  considered: number;
  /** Excluded by `.xxignore` (and, on the walk fallback, `.gitignore`). */
  ignored: RepoMapOmission;
  /** `stat`/`read` failed, or the path is not a regular file. */
  unreadable: RepoMapOmission;
  /** Larger than {@link MAX_FILE_BYTES}. */
  oversized: RepoMapOmission;
  /** A NUL byte in the first {@link BINARY_SNIFF_BYTES} bytes. */
  binary: RepoMapOmission;
  /** Zero-length; carries no context and was already being dropped in silence. */
  empty: RepoMapOmission;
  /**
   * Ranked below {@link MAX_SELECTION_CANDIDATES} and therefore never offered
   * to selection at all — distinct from `droppedForBudget`, which competed and
   * lost. A capped run is never silently partial.
   */
  droppedForScale: RepoMapOmission;
  /** Readable source that simply did not fit `tokenBudget`. */
  droppedForBudget: RepoMapOmission;
  /** Included, but only a head of it — the tail is not in `ranges`. */
  truncated: RepoMapOmission;
}

/** Where the applied token budget came from, and what it was derived from. */
export interface RepoMapBudget {
  /** The budget actually applied. */
  tokenBudget: number;
  /**
   * `explicit` — the caller named a budget, used verbatim.
   * `contextWindow` — derived from a caller-supplied window.
   * `model` — derived from the window the registry records for that model.
   * `default` — no window was available; {@link DEFAULT_TOKEN_BUDGET}.
   */
  source: "explicit" | "contextWindow" | "model" | "default";
  /** The nominal window the budget was derived from, or null. */
  contextWindow: number | null;
  /**
   * Tokens held back for the prompt itself. Always 0 for an `explicit` budget:
   * a caller-named budget is used exactly as given.
   */
  reservedTokens: number;
}

export interface RepoMapResult {
  files: RepoMapFile[];
  tokensEstimated: number;
  method: "heuristic" | "treesitter";
  omissions: RepoMapOmissions;
  /** The budget that was applied, and where it came from. */
  budget: RepoMapBudget;
}

export interface BuildRepoMapOptions {
  root: string;
  /**
   * Explicit budget. Always wins: when present the model/window inputs below
   * are not consulted and nothing is reserved.
   */
  tokenBudget?: number;
  focusPaths?: string[];
  includeSymbols?: boolean;
  /**
   * Model the context is being built for. When `tokenBudget` is omitted the
   * budget is derived from this model's context window as recorded in the
   * platform registry (a file read — no network call, and no probe).
   */
  model?: string;
  /** Host id, to disambiguate a model name served by more than one host. */
  host?: string;
  /**
   * Nominal context window, when the caller already knows it. Wins over the
   * registry lookup; skips it entirely.
   */
  contextWindow?: number;
  /**
   * Tokens to hold back from a *derived* budget for the rest of the prompt —
   * system prompt, task, tool definitions, conversation so far. Ignored when
   * `tokenBudget` is explicit.
   */
  reservedTokens?: number;
  /**
   * Override {@link MAX_SELECTION_CANDIDATES}. Exists so the suite can exercise
   * the cap without a thousand-file fixture, and so a caller who knows their
   * repo can trade memory for reach; the default is the supported setting.
   */
  maxCandidates?: number;
}

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/**
 * Budget used when nothing is known about the target model's context window.
 * The historical hardcoded value, kept exactly: an unknown or absent window
 * must land on the same number the tool returned before it could derive one.
 */
export const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Fraction of a model's *nominal* context window the repo map may occupy when
 * it derives its own budget.
 *
 * Nameplate context is not usable context — the same insight already accepted
 * for VRAM in the residency work, where hosts reserve 20-25%
 * (`executionPolicy.contextReservePercent`) rather than plan against the
 * sticker number. For context windows the gap is wider still, for two reasons
 * that compound:
 *
 * - The repo map is one input among several. The window also has to hold the
 *   system prompt, the task, tool definitions, prior turns, and the model's
 *   own output. A repo map that fills the window leaves nothing to think with.
 * - Quality and latency degrade well before the nominal limit. Attention
 *   dilutes over long contexts and prefill cost grows with it, which matters
 *   most for exactly the small local models this stack targets.
 *
 * 0.25 is also what the old hardcoded default already implied: 8,000 tokens is
 * 24.4% of a 32,768-token window, the commonest local size. So the discount
 * keeps today's behaviour for the model class the hardcoded number was written
 * for, and scales from there — a 262,144-window lane (the one this registry
 * records) gets 65,536 instead of 8,000, and a 4,096-token lane gets 1,024
 * instead of an 8,000-token budget it could never have honoured.
 */
export const USABLE_CONTEXT_FRACTION = 0.25;

/**
 * Floor for a derived budget. A tiny window with a large `reservedTokens` can
 * arithmetically produce zero or less, and `selectContext` treats a
 * non-positive budget as "select nothing" — an empty map is a worse answer than
 * a small one. 512 tokens still returns the head of the top-ranked file.
 */
export const MIN_DERIVED_TOKEN_BUDGET = 512;

/**
 * Look up a model's recorded context window in the platform registry.
 *
 * When more than one host serves the same model name the smallest window wins:
 * the budget has to be honourable wherever the task actually lands, and a
 * too-small map is recoverable where an overflowing one is not.
 */
export function findContextWindow(
  registry: Registry,
  modelName: string,
  hostId?: string
): number | null {
  let smallest: number | null = null;
  for (const tier of registry.tiers ?? []) {
    for (const host of tier.hosts ?? []) {
      if (hostId !== undefined && host.id !== hostId) continue;
      for (const model of host.models ?? []) {
        if (typeof model === "string") continue;
        if (model?.name !== modelName) continue;
        const window = model?.contextWindow;
        if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
        if (smallest === null || window < smallest) smallest = window;
      }
    }
  }
  return smallest;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Resolve the budget to apply. Degrades in one direction only: any input that
 * is missing, malformed, or unresolvable lands on {@link DEFAULT_TOKEN_BUDGET},
 * never on an exception and never on a budget the caller did not ask for.
 */
async function resolveBudget(options: BuildRepoMapOptions): Promise<RepoMapBudget> {
  const explicit = positiveInt(options.tokenBudget);
  if (explicit !== null) {
    return { tokenBudget: explicit, source: "explicit", contextWindow: null, reservedTokens: 0 };
  }

  let window = positiveInt(options.contextWindow);
  let source: RepoMapBudget["source"] = window === null ? "default" : "contextWindow";

  if (window === null && options.model) {
    try {
      const registry = await __repoMapIo.loadRegistry();
      window = positiveInt(findContextWindow(registry, options.model, options.host));
      if (window !== null) source = "model";
    } catch {
      // No registry, or an unreadable one. A repo map is not the place to fail
      // over a routing file; fall through to the default budget.
      window = null;
    }
  }

  if (window === null) {
    return {
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      source: "default",
      contextWindow: null,
      reservedTokens: 0,
    };
  }

  const reserved = Math.max(0, positiveInt(options.reservedTokens) ?? 0);
  const derived = Math.floor(window * USABLE_CONTEXT_FRACTION) - reserved;
  return {
    tokenBudget: Math.max(MIN_DERIVED_TOKEN_BUDGET, derived),
    source,
    contextWindow: window,
    reservedTokens: reserved,
  };
}

/**
 * Ceiling on how many files are handed to submodular selection.
 *
 * `selectContext` builds a full n x n similarity matrix. At the ~900 files of
 * this repo that is 6 MB and ~0.8s; at 20,000 files it is 3.2 GB and minutes.
 * The constant factor is not the problem — `prepare()` already tokenizes each
 * candidate once rather than per pair — the absence of a ceiling is.
 *
 * 1,000 is where two independent bounds meet:
 *
 * - **It cannot cost quality.** The most files any budget could select is
 *   bounded above by packing the *smallest* files first, which the rank-ordered
 *   greedy never does. Measured on this repo that bound is 54 files at the
 *   8,000 default, 213 at 65,536 (the largest budget derivable here — the
 *   262,144-window lane at {@link USABLE_CONTEXT_FRACTION}) and 315 at an
 *   implausible 131,072; the cap is 4.7x and 3.2x those. What the map *really*
 *   returns at those budgets is 4, 17 and 27 files, so the cap sits ~37x above
 *   the largest realistic selection.
 * - **It keeps the <2s acceptance criterion true at any repo size.** The
 *   similarity stage is O(K^2); measured on this repo's files, 1,000
 *   candidates cost ~0.96s and 7.6 MB, 1,500 cost ~2.2s and 17 MB. 1,500 alone
 *   would blow the budget the rest of this work exists to meet.
 *
 * Files above the cap are reported as `droppedForScale`, so a run that hits it
 * says so.
 */
export const MAX_SELECTION_CANDIDATES = 1000;

// ---------------------------------------------------------------------------
// Read guards
// ---------------------------------------------------------------------------

/**
 * Refuse to read any file larger than 2 MiB.
 *
 * Every path from `git ls-files` used to go straight into
 * `readFileSync(fullPath, "utf8")` with no `stat` in front of it. A 20 MB
 * random binary was not merely read, it was ranked, selected, and returned as
 * code context; a file in the 0.5-2 GB range fails inside V8 with an
 * uncatchable heap or max-string-length error and takes the MCP server process
 * down with it.
 *
 * 2 MiB is chosen to be far too generous to ever drop real code:
 *
 * - The largest text file tracked in this repo is 108 KB
 *   (the repository history); the largest source file is 82 KB. The cap is
 *   ~19x the former.
 * - It cannot cost the caller a file they could have used. At the ~4 chars per
 *   token this module already estimates with, 2 MiB is ~524,000 tokens. The
 *   default `tokenBudget` is 8,000 (~32 KB) and even an implausibly large
 *   budget is orders of magnitude short, so a file at the cap could never be
 *   selected whole — only as the truncated head, which is exactly the case
 *   where reading the whole file was pure waste.
 *
 * Deliberately NOT added: an extension allowlist. Any such list drops real
 * code — extensionless scripts, `Makefile`, `Dockerfile`, and every language
 * nobody thought to enumerate — and the NUL sniff below already excludes the
 * actual hazard without guessing at filenames.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Bytes sniffed for a NUL before treating a file as binary.
 *
 * 8000 is git's own `FIRST_FEW_BYTES` constant (`xdiff-interface.c`), so our
 * verdict agrees with `git diff`'s "Binary files ... differ" on the same file
 * rather than inventing a second definition of binary.
 */
export const BINARY_SNIFF_BYTES = 8000;

/** Maximum paths reported per omission class. */
export const OMISSION_EXAMPLE_LIMIT = 10;

type OmissionClass = Exclude<keyof RepoMapOmissions, "considered">;

const OMISSION_CLASSES: OmissionClass[] = [
  "ignored",
  "unreadable",
  "oversized",
  "binary",
  "empty",
  "droppedForScale",
  "droppedForBudget",
  "truncated",
];

/** Classes whose examples are kept in rank order rather than sorted. */
const RANK_ORDERED: ReadonlySet<OmissionClass> = new Set<OmissionClass>([
  "droppedForScale",
  "droppedForBudget",
  "truncated",
]);

interface OmissionAccumulator {
  considered: number;
  counts: Record<OmissionClass, number>;
  examples: Record<OmissionClass, string[]>;
}

function newOmissions(): OmissionAccumulator {
  const counts = {} as Record<OmissionClass, number>;
  const examples = {} as Record<OmissionClass, string[]>;
  for (const cls of OMISSION_CLASSES) {
    counts[cls] = 0;
    examples[cls] = [];
  }
  return { considered: 0, counts, examples };
}

function noteOmission(acc: OmissionAccumulator, cls: OmissionClass, path: string): void {
  acc.counts[cls] += 1;
  const list = acc.examples[cls];
  if (RANK_ORDERED.has(cls)) {
    if (list.length < OMISSION_EXAMPLE_LIMIT) list.push(path);
    return;
  }
  // Bounded sorted insert: keeps the lexicographically first N without ever
  // holding more than N paths.
  let i = 0;
  while (i < list.length && list[i] < path) i++;
  if (i >= OMISSION_EXAMPLE_LIMIT) return;
  list.splice(i, 0, path);
  if (list.length > OMISSION_EXAMPLE_LIMIT) list.pop();
}

function finalizeOmissions(acc: OmissionAccumulator): RepoMapOmissions {
  const out = { considered: acc.considered } as RepoMapOmissions;
  for (const cls of OMISSION_CLASSES) {
    out[cls] = { count: acc.counts[cls], examples: acc.examples[cls] };
  }
  return out;
}

type ReadOutcome =
  | { ok: true; content: string }
  | { ok: false; reason: "unreadable" | "oversized" | "binary" | "empty" };

/**
 * Read a file as text, or say why not. Both guards run before the full read:
 * `statSync` rejects on size without opening, and the NUL sniff runs against a
 * bounded prefix of a buffer that is already known to be under the cap.
 */
function readTextFile(fullPath: string): ReadOutcome {
  let size: number;
  try {
    const st = statSync(fullPath);
    if (!st.isFile()) return { ok: false, reason: "unreadable" };
    size = st.size;
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  if (size > MAX_FILE_BYTES) return { ok: false, reason: "oversized" };
  if (size === 0) return { ok: false, reason: "empty" };

  let buf: Buffer;
  try {
    buf = readFileSync(fullPath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const prefix = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  if (prefix.indexOf(0) >= 0) return { ok: false, reason: "binary" };

  const content = buf.toString("utf8");
  if (content.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, content };
}

// ---------------------------------------------------------------------------
// Ignore-file helpers
// ---------------------------------------------------------------------------

/**
 * One parsed ignore line.
 *
 * `loadIgnorePatterns` used to return bare strings, which pushed `!keep.log`
 * verbatim as a *positive* pattern: a negation re-included a file and we
 * excluded it under the very name that was supposed to save it. Rules carry
 * their polarity now, and `isIgnored` resolves them last-match-wins.
 */
interface IgnoreRule {
  /** `!pattern` — a match re-includes rather than excludes. */
  negated: boolean;
  /** Trailing `/` — matches directories only, never a file of that name. */
  dirOnly: boolean;
  /** Compiled from the pattern body; already carries any `**\/` prefix. */
  regex: RegExp;
  /** Which file the rule came from, for diagnostics. */
  source: string;
}

function parseIgnoreFile(filePath: string, source: string): IgnoreRule[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of content.split("\n")) {
    const rule = parseIgnoreLine(line, source);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseIgnoreLine(line: string, source: string): IgnoreRule | null {
  let text = line.trim();
  if (!text) return null;
  if (text.startsWith("#")) return null;

  let negated = false;
  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith("\\#") || text.startsWith("\\!")) {
    // gitignore escapes for a literal leading `#` or `!`.
    text = text.slice(1);
  }
  if (!text) return null;

  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.slice(0, -1);

  const leadingSlash = text.startsWith("/");
  if (leadingSlash) text = text.slice(1);
  if (!text) return null;

  // gitignore: a separator anywhere but the end anchors the pattern to the
  // ignore file's directory. Otherwise it matches at any depth, which is the
  // same thing as an implicit `**/` prefix.
  const anchored = leadingSlash || text.includes("/");
  const body = globToRegExpSource(text);
  const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);

  return { negated, dirOnly, regex, source };
}

function loadIgnoreRules(root: string, files: string[]): IgnoreRule[] {
  // `.git/` is never repo content and no ignore file is required to say so.
  const rules: IgnoreRule[] = [parseIgnoreLine(".git/", "built-in")!];
  for (const name of files) {
    const p = join(root, name);
    if (existsSync(p)) rules.push(...parseIgnoreFile(p, name));
  }
  return rules;
}

/**
 * Last match wins, exactly as git resolves ignore rules: a later `!pattern`
 * re-includes a path an earlier pattern excluded, and a later positive pattern
 * excludes it again.
 *
 * One deliberate divergence from git, in the permissive direction: git cannot
 * re-include a file whose *parent directory* is excluded, so `dist/` followed
 * by `!dist/keep.txt` keeps nothing. Here the later rule wins and `keep.txt`
 * comes back. Emulating git's restriction means dropping a file the author
 * explicitly named, which is the failure mode this whole change exists to
 * remove, so the divergence is intentional and errs toward including too much.
 */
function isIgnored(relPath: string, rules: IgnoreRule[]): boolean {
  let verdict: IgnoreRule | null = null;
  for (const rule of rules) {
    if (ruleMatches(relPath, rule)) verdict = rule;
  }
  return verdict !== null && !verdict.negated;
}

function ruleMatches(relPath: string, rule: IgnoreRule): boolean {
  // A rule matching an ancestor directory excludes everything beneath it —
  // `node_modules` without a trailing slash must still exclude
  // `node_modules/x.ts`, which the previous basename-only matcher did not do.
  const segments = relPath.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (rule.regex.test(segments.slice(0, i).join("/"))) return true;
  }
  if (rule.dirOnly) return false;
  return rule.regex.test(relPath);
}

/**
 * Compile a gitignore-style glob to a regex source (no anchors).
 *
 * Supported: `*` (within one path segment), `?`, `**` in any position
 * (leading, trailing, or mid-pattern as `a/**\/b`, which also matches `a/b`),
 * character classes `[abc]` / `[a-z]` / `[!a-z]`, and `\` escaping.
 *
 * Not supported, deliberately: `{a,b}` brace alternation, which gitignore does
 * not have either.
 */
function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*") {
      let stars = 0;
      while (pattern[i] === "*") {
        stars++;
        i++;
      }
      if (stars >= 2) {
        // `**/` collapses to "zero or more leading segments" so `a/**/b`
        // matches `a/b` as well as `a/x/y/b`.
        if (pattern[i] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    if (c === "[") {
      const cls = parseCharClass(pattern, i);
      if (cls) {
        out += cls.source;
        i = cls.next;
        continue;
      }
      out += "\\[";
      i++;
      continue;
    }

    if (c === "\\" && i + 1 < pattern.length) {
      out += escapeRegexChar(pattern[i + 1]);
      i += 2;
      continue;
    }

    out += escapeRegexChar(c);
    i++;
  }
  return out;
}

function parseCharClass(pattern: string, start: number): { source: string; next: number } | null {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  let body = "";
  // A `]` immediately after the (optional) negation is a literal member.
  if (pattern[i] === "]") {
    body += "\\]";
    i++;
  }
  while (i < pattern.length && pattern[i] !== "]") {
    const ch = pattern[i];
    // `\` and `[` are the only members needing escaping once inside a class;
    // `-` is left alone so ranges keep working.
    body += ch === "\\" || ch === "[" ? `\\${ch}` : ch;
    i++;
  }
  // Unterminated class, or `[]` — treat the `[` as a literal.
  if (i >= pattern.length || body === "") return null;
  return { source: `[${negate ? "^" : ""}${body}]`, next: i + 1 };
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

// ---------------------------------------------------------------------------
// File discovery (via git ls-files)
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  files: string[];
  /** Paths discovery emitted before our ignore filtering. */
  considered: number;
  /** Paths our ignore rules removed, in discovery order. */
  ignored: string[];
}

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
 *
 * `--exclude-standard` means git has *already* applied `.gitignore` correctly,
 * including negations. We deliberately do not re-apply it: the second pass was
 * strictly redundant on everything it got right, and on `!keep.log` it was
 * wrong — it re-excluded a file git had deliberately re-included, with nothing
 * reporting the loss. Only `.xxignore`, which git knows nothing about, is
 * applied here. The walk fallback below has no git safety net and so applies
 * both, through the same last-match-wins matcher.
 */
async function discoverFiles(root: string): Promise<DiscoveryResult> {
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
    return discoverFilesByWalk(root);
  }

  // NUL-separated, so a filename may legally contain a newline.
  const allFiles = output.split("\0").filter(Boolean);
  const rules = loadIgnoreRules(root, [".xxignore"]);

  const files: string[] = [];
  const ignored: string[] = [];
  for (const f of allFiles) {
    if (isIgnored(f, rules)) ignored.push(f);
    else files.push(f);
  }
  return { files, considered: allFiles.length, ignored };
}

/**
 * Fallback: walk the filesystem to discover files.
 * Used when git is not available.
 */
async function discoverFilesByWalk(root: string): Promise<DiscoveryResult> {
  const rules = loadIgnoreRules(root, [".xxignore", ".gitignore"]);
  const results: string[] = [];
  const ignored: string[] = [];
  let considered = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // readdir order is filesystem-dependent; sort so the walk — and therefore
    // every omission sample derived from it — is reproducible.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      if (isIgnored(relPath, rules)) {
        // A pruned directory counts as one considered entry, not as the files
        // beneath it — see `RepoMapOmissions.considered`.
        considered++;
        ignored.push(relPath);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        considered++;
        results.push(relPath);
      }
    }
  }

  await walk(root);
  return { files: results, considered, ignored };
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
    const out = __repoMapIo.execFileSync("git", ["log", "-1", "--format=%ct", "--", rel], {
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

/**
 * Marker prefixed to each commit header in the recency walk.
 *
 * `--name-only` interleaves commit headers with path lists in one stream, so
 * the parser has to tell them apart. A bare `%ct` cannot be told from a file
 * literally named `1785760520`; a leading `/` can, because `--name-only`
 * emits repo-relative paths and never an absolute one.
 */
const GIT_LOG_COMMIT_PREFIX = "/";

/**
 * Last-commit timestamp (ms) for every path in the repo's history, in **one**
 * `git log`.
 *
 * This replaces one `execFileSync("git log")` per discovered file. On this
 * repo that was 899 spawns costing ~2.4s of a ~2.9s repo map — against a
 * recorded acceptance criterion of <2s — where the whole history walk costs
 * ~20ms.
 *
 * Parsing notes, each one a way this goes wrong:
 *
 * - `-z` for the same reason `git ls-files` needs it: without it git C-quotes
 *   any path with a quote, a backslash, a control character or a non-ASCII
 *   byte, and the quoted string names no real file.
 * - The stream is `<header>NUL "\n"<path>NUL<path>NUL...`. The newline belongs
 *   to git's header/list separator and is only emitted when a commit has a
 *   path list, so it is stripped from the first record after a header and
 *   nowhere else — a file whose name legitimately begins with a newline keeps
 *   its name.
 * - A path repeats across every commit that touched it, and history is not
 *   ordered by commit date, so the newest timestamp wins rather than the first
 *   one seen. Deleted and renamed paths appear too; they simply never get
 *   looked up.
 * - `--relative` because `root` may be a subdirectory of the repo, where
 *   `git ls-files` prints paths relative to cwd but `git log` would print them
 *   relative to the repo top level.
 *
 * Returns null — never throws — when the walk is unusable (not a git repo, git
 * missing, output past `maxBuffer`, timeout). The caller then degrades to the
 * per-file behaviour this replaced.
 */
export function collectGitTimestamps(cwd: string): Map<string, number> | null {
  let output: string;
  try {
    output = __repoMapIo.execFileSync(
      "git",
      ["log", "-z", "--name-only", "--relative", `--format=${GIT_LOG_COMMIT_PREFIX}%ct`],
      {
        cwd,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  } catch {
    return null;
  }

  const timestamps = new Map<string, number>();
  let current = 0;
  let afterHeader = false;

  for (const record of output.split("\0")) {
    let text = record;
    if (afterHeader && text.startsWith("\n")) {
      text = text.slice(1);
      afterHeader = false;
    }
    if (text === "") continue;

    if (text.startsWith(GIT_LOG_COMMIT_PREFIX)) {
      const seconds = Number(text.slice(GIT_LOG_COMMIT_PREFIX.length));
      current = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
      afterHeader = true;
      continue;
    }

    if (current === 0) continue;
    const known = timestamps.get(text);
    if (known === undefined || current > known) timestamps.set(text, current);
  }

  return timestamps;
}

/**
 * True when `root` is inside a git worktree.
 *
 * Only consulted when the bulk walk failed, to decide whether the per-file
 * fallback could possibly do better. Without it a non-git directory would pay
 * one doomed spawn per file — the exact cost the bulk walk exists to remove.
 */
function isGitRepo(cwd: string): boolean {
  try {
    __repoMapIo.execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count import-ish references in already-read content.
 *
 * This used to do its own unguarded `readFileSync(fullPath, "utf8")`, which
 * made it the second place a 2 GB blob could kill the process and meant every
 * file was read twice per map. It takes the content the caller already has.
 */
function countReferences(content: string): number {
  const importPatterns = [/(?:import|export)\s+/g, /require\s*\(/g, /from\s+['"]/g];
  let count = 0;
  for (const re of importPatterns) {
    const matches = content.match(re);
    if (matches) count += matches.length;
  }
  return count;
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
  const { root, focusPaths = [], includeSymbols = false } = options;

  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Repo root not found: ${resolvedRoot}`);
  }

  const budget = await resolveBudget(options);
  const tokenBudget = budget.tokenBudget;
  const maxCandidates = positiveInt(options.maxCandidates) ?? MAX_SELECTION_CANDIDATES;

  const omissions = newOmissions();
  const discovery = await discoverFiles(resolvedRoot);
  omissions.considered = discovery.considered;
  for (const path of discovery.ignored) noteOmission(omissions, "ignored", path);

  const allFiles = discovery.files;
  if (allFiles.length === 0) {
    return {
      files: [],
      tokensEstimated: 0,
      method: "heuristic",
      omissions: finalizeOmissions(omissions),
      budget,
    };
  }

  // One `git log` for the whole repo. Only when that is unusable *and* git
  // could still answer per file do we pay the old spawn-per-file price.
  const bulkTimestamps = collectGitTimestamps(resolvedRoot);
  const perFileTimestamps = bulkTimestamps === null && isGitRepo(resolvedRoot);

  // Each file is read exactly once, behind the size and binary guards, and the
  // content is carried through scoring and selection.
  const contents = new Map<string, string>();
  const signals: FileSignals[] = [];
  for (const relPath of allFiles) {
    const fullPath = join(resolvedRoot, relPath);
    const outcome = readTextFile(fullPath);
    if (!outcome.ok) {
      noteOmission(omissions, outcome.reason, relPath);
      continue;
    }
    contents.set(relPath, outcome.content);
    signals.push({
      path: relPath,
      gitTimestamp: bulkTimestamps
        ? (bulkTimestamps.get(relPath) ?? 0)
        : perFileTimestamps
          ? getGitTimestamp(fullPath, resolvedRoot)
          : 0,
      proximityScore: computeProximityScore(relPath, focusPaths),
      refCount: countReferences(outcome.content),
    });
  }

  if (signals.length === 0) {
    return {
      files: [],
      tokensEstimated: 0,
      method: "heuristic",
      omissions: finalizeOmissions(omissions),
      budget,
    };
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

  // Cap the candidate set before selection: rank by the cheap heuristic first,
  // then run the O(n^2) submodular pass over the top K only. Everything below
  // the cap is reported (`droppedForScale`), never dropped in silence.
  const ranked = signals.slice(0, maxCandidates);
  for (const s of signals.slice(maxCandidates)) noteOmission(omissions, "droppedForScale", s.path);

  // -------------------------------------------------------------------------
  // Budget fitting via submodular context selection (context_selection_runtime).
  // The heuristic score above stays the relevance signal; coverage/diversity
  // come from cheap lexical similarity over file contents. minGain is
  // -Infinity so the repo-map contract is unchanged: fill the budget rather
  // than stop at the first non-positive marginal gain.
  // -------------------------------------------------------------------------

  const candidates: ContextCandidate[] = ranked.map((s) => {
    const text = contents.get(s.path) ?? "";
    return { id: s.path, text, tokens: estimateTokens(text), relevance: s.proximityScore };
  });

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

  for (const s of ranked) {
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
  let truncatedPath: string | null = null;
  const remaining = tokenBudget - runningTokens;
  if (remaining > 0) {
    const next = ranked.find((s) => !chosen.has(s.path));
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
        // Included, but not whole: `ranges` alone cannot tell the caller how
        // much of the file it is missing, so say so.
        if (lineBudget < lines.length) {
          truncatedPath = next.path;
          noteOmission(omissions, "truncated", next.path);
        } else {
          chosen.add(next.path);
        }
      }
    }
  }

  for (const s of ranked) {
    if (chosen.has(s.path) || s.path === truncatedPath) continue;
    noteOmission(omissions, "droppedForBudget", s.path);
  }

  return {
    files: selected,
    tokensEstimated: runningTokens,
    method: "heuristic",
    omissions: finalizeOmissions(omissions),
    budget,
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
