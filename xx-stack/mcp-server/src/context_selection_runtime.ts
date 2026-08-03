// Submodular context selection under token budgets.
//
// Pure TypeScript, zero dependencies, fully deterministic for fixed inputs.
// The objective balances three signals when picking which candidates fit into
// a token budget:
//   - relevance:  how well a candidate matches the query (or a caller-supplied
//                 precomputed relevance score),
//   - coverage:   facility-location coverage of the whole candidate set
//                 (picking something "close" to many unpicked items is good),
//   - diversity:  a penalty for similarity to already-selected items
//                 (near-duplicates of a pick gain nothing).
//
// The marginal gain of adding candidate i to selection S is:
//   gain(i | S) = wr * rel(i)
//               + wc * (1/n) * sum_j max(0, sim(i,j) - cov_S(j))
//               - wd * max_{s in S} sim(i, s)
// where cov_S(j) = max_{s in S} sim(s, j).
//
// rel is constant in S, the coverage term has diminishing returns, and the
// diversity penalty is non-decreasing in S — so gain(i | S) is non-increasing
// as S grows. That monotonicity is exactly what makes lazy-greedy (stale
// cached gains used as upper bounds) return the same picks as naive greedy.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextCandidate {
  /** Stable identifier for the candidate (file path, entry hash, ...). */
  id: string;
  /** Text used for similarity/relevance signals. */
  text: string;
  /** Token cost; estimated from text length when omitted. */
  tokens?: number;
  /**
   * Optional precomputed relevance score. When present it overrides the
   * query-overlap relevance signal (used by callers that already rank
   * candidates, e.g. the repo map's heuristic score).
   */
  relevance?: number;
}

/** Pluggable similarity signal: returns a score in [0, 1] for two texts. */
export type SimilarityFn = (a: string, b: string) => number;

export interface ContextSelectionWeights {
  relevance?: number;
  coverage?: number;
  diversity?: number;
}

export interface SelectContextOptions {
  candidates: ContextCandidate[];
  /** Token budget the selected subset must fit into. */
  tokenBudget: number;
  /** Optional query; drives the relevance term via the similarity signal. */
  query?: string;
  /** Similarity signal override; defaults to cheap lexical token overlap. */
  similarity?: SimilarityFn;
  /** Objective weights; each defaults to 1. */
  weights?: ContextSelectionWeights;
  /**
   * Selection stops once the best marginal gain is <= minGain (default 0, so
   * only strictly-useful picks are made and near-duplicates are left out).
   * Pass Number.NEGATIVE_INFINITY to keep filling the budget regardless of
   * gain (pure budget-fitting mode, used by the repo map).
   */
  minGain?: number;
}

export interface SelectedContextItem {
  id: string;
  /** Index into the input candidates array. */
  index: number;
  /** Token cost charged against the budget. */
  tokens: number;
  /** Marginal gain at the moment this item was selected. */
  gain: number;
}

export interface ContextSelectionResult {
  /** Selected items in selection (gain) order. */
  selected: SelectedContextItem[];
  /** Sum of the selected items' token costs (always <= tokenBudget). */
  tokensEstimated: number;
  /** Number of marginal-gain evaluations performed (lazy-greedy diagnostic). */
  evaluations: number;
}

// ---------------------------------------------------------------------------
// Token estimation + lexical similarity (default signal)
// ---------------------------------------------------------------------------

/** Cheap token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cap the characters fed into tokenization so pairwise similarity on large
 * files stays fast; deterministic because it is a fixed prefix. */
const SIMILARITY_CHAR_CAP = 8000;

function tokenizeForSimilarity(text: string): Set<string> {
  const capped = text.length > SIMILARITY_CHAR_CAP ? text.slice(0, SIMILARITY_CHAR_CAP) : text;
  const tokens = capped.toLowerCase().split(/[^a-z0-9]+/);
  const set = new Set<string>();
  for (const t of tokens) {
    if (t.length > 0) set.add(t);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Default similarity signal: Jaccard overlap of lexical token sets. */
export function lexicalSimilarity(a: string, b: string): number {
  return jaccard(tokenizeForSimilarity(a), tokenizeForSimilarity(b));
}

// ---------------------------------------------------------------------------
// Shared objective machinery
// ---------------------------------------------------------------------------

interface Prepared {
  n: number;
  costs: number[];
  rel: number[];
  /** Full pairwise similarity matrix (sim[i][j] === sim[j][i]). */
  sim: number[][];
  wr: number;
  wc: number;
  wd: number;
  minGain: number;
}

function prepare(options: SelectContextOptions): Prepared {
  const { candidates, query, similarity, weights, minGain } = options;
  const n = candidates.length;
  const costs = candidates.map((c) =>
    typeof c.tokens === "number" && Number.isFinite(c.tokens) && c.tokens >= 0
      ? c.tokens
      : estimateTokens(c.text)
  );

  // Similarity matrix. The default lexical path pre-tokenizes each candidate
  // once; a custom similarity fn is called per unique pair.
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  if (similarity) {
    for (let i = 0; i < n; i += 1) {
      for (let j = i; j < n; j += 1) {
        const s = similarity(candidates[i].text, candidates[j].text);
        sim[i][j] = s;
        sim[j][i] = s;
      }
    }
  } else {
    const tokenSets = candidates.map((c) => tokenizeForSimilarity(c.text));
    for (let i = 0; i < n; i += 1) {
      for (let j = i; j < n; j += 1) {
        const s = jaccard(tokenSets[i], tokenSets[j]);
        sim[i][j] = s;
        sim[j][i] = s;
      }
    }
  }

  const rel: number[] = new Array<number>(n).fill(0);
  const simFn = similarity ?? lexicalSimilarity;
  const queryTokens = query !== undefined ? tokenizeForSimilarity(query) : null;
  for (let i = 0; i < n; i += 1) {
    const explicit = candidates[i].relevance;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      rel[i] = explicit;
    } else if (query !== undefined) {
      rel[i] = similarity
        ? simFn(query, candidates[i].text)
        : jaccard(queryTokens as Set<string>, tokenizeForSimilarity(candidates[i].text));
    }
  }

  return {
    n,
    costs,
    rel,
    sim,
    wr: weights?.relevance ?? 1,
    wc: weights?.coverage ?? 1,
    wd: weights?.diversity ?? 1,
    minGain: minGain ?? 0,
  };
}

function marginalGain(p: Prepared, i: number, cov: number[], selectedIdx: number[]): number {
  let covGain = 0;
  const simRow = p.sim[i];
  for (let j = 0; j < p.n; j += 1) {
    const d = simRow[j] - cov[j];
    if (d > 0) covGain += d;
  }
  covGain /= p.n;

  let divPenalty = 0;
  for (const s of selectedIdx) {
    if (simRow[s] > divPenalty) divPenalty = simRow[s];
  }

  return p.wr * p.rel[i] + p.wc * covGain - p.wd * divPenalty;
}

function applySelection(p: Prepared, i: number, cov: number[]): void {
  const simRow = p.sim[i];
  for (let j = 0; j < p.n; j += 1) {
    if (simRow[j] > cov[j]) cov[j] = simRow[j];
  }
}

// ---------------------------------------------------------------------------
// Lazy-greedy selection (main entry point)
// ---------------------------------------------------------------------------

/**
 * Select a subset of candidates that fits `tokenBudget`, maximizing
 * relevance + coverage - redundancy via lazy-greedy submodular optimization.
 * Deterministic: ties break toward the lower candidate index.
 */
export function selectContext(options: SelectContextOptions): ContextSelectionResult {
  const empty: ContextSelectionResult = { selected: [], tokensEstimated: 0, evaluations: 0 };
  if (options.candidates.length === 0) return empty;
  if (!Number.isFinite(options.tokenBudget) || options.tokenBudget <= 0) return empty;

  const p = prepare(options);
  const cov = new Array<number>(p.n).fill(0);
  const selectedIdx: number[] = [];
  const selected: SelectedContextItem[] = [];
  let used = 0;
  let evaluations = 0;

  const alive = new Array<boolean>(p.n).fill(true);
  const cached = new Array<number>(p.n).fill(Number.POSITIVE_INFINITY);
  const lastEvalRound = new Array<number>(p.n).fill(-1);
  let round = 0;

  // Candidates that never fit the budget can be dropped up front; the budget
  // only shrinks, so "doesn't fit" is permanent.
  for (let i = 0; i < p.n; i += 1) {
    if (p.costs[i] > options.tokenBudget) alive[i] = false;
  }

  for (;;) {
    const remaining = options.tokenBudget - used;
    for (let i = 0; i < p.n; i += 1) {
      if (alive[i] && p.costs[i] > remaining) alive[i] = false;
    }

    let done = false;
    let picked = -1;
    for (;;) {
      // Find the alive candidate with the highest cached gain (ties -> lower index).
      let best = -1;
      for (let i = 0; i < p.n; i += 1) {
        if (!alive[i]) continue;
        if (best === -1 || cached[i] > cached[best]) best = i;
      }
      if (best === -1) {
        done = true;
        break;
      }
      if (lastEvalRound[best] === round) {
        // Fresh evaluation is still the max of all upper bounds: it is the
        // true argmax. Stop entirely if it is not worth picking.
        if (cached[best] <= p.minGain) {
          done = true;
        } else {
          picked = best;
        }
        break;
      }
      cached[best] = marginalGain(p, best, cov, selectedIdx);
      lastEvalRound[best] = round;
      evaluations += 1;
    }

    if (done || picked === -1) break;

    selected.push({
      id: options.candidates[picked].id,
      index: picked,
      tokens: p.costs[picked],
      gain: cached[picked],
    });
    used += p.costs[picked];
    applySelection(p, picked, cov);
    selectedIdx.push(picked);
    alive[picked] = false;
    round += 1;
  }

  return { selected, tokensEstimated: used, evaluations };
}

// ---------------------------------------------------------------------------
// Naive greedy (reference implementation)
// ---------------------------------------------------------------------------

/**
 * Reference implementation: recompute every marginal gain each round and pick
 * the max. Produces exactly the same selection as `selectContext`; kept
 * exported so tests can verify the lazy-greedy shortcut changes nothing.
 */
export function naiveGreedySelect(options: SelectContextOptions): ContextSelectionResult {
  const empty: ContextSelectionResult = { selected: [], tokensEstimated: 0, evaluations: 0 };
  if (options.candidates.length === 0) return empty;
  if (!Number.isFinite(options.tokenBudget) || options.tokenBudget <= 0) return empty;

  const p = prepare(options);
  const cov = new Array<number>(p.n).fill(0);
  const selectedIdx: number[] = [];
  const selected: SelectedContextItem[] = [];
  const taken = new Array<boolean>(p.n).fill(false);
  let used = 0;
  let evaluations = 0;

  for (;;) {
    const remaining = options.tokenBudget - used;
    let best = -1;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < p.n; i += 1) {
      if (taken[i] || p.costs[i] > remaining) continue;
      const g = marginalGain(p, i, cov, selectedIdx);
      evaluations += 1;
      if (g > bestGain) {
        bestGain = g;
        best = i;
      }
    }
    if (best === -1 || bestGain <= p.minGain) break;

    selected.push({
      id: options.candidates[best].id,
      index: best,
      tokens: p.costs[best],
      gain: bestGain,
    });
    used += p.costs[best];
    applySelection(p, best, cov);
    selectedIdx.push(best);
    taken[best] = true;
  }

  return { selected, tokensEstimated: used, evaluations };
}
