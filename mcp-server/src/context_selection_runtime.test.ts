import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextCandidate,
  estimateTokens,
  lexicalSimilarity,
  naiveGreedySelect,
  selectContext,
} from "./context_selection_runtime.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candidate(id: string, text: string, tokens?: number): ContextCandidate {
  return { id, text, tokens };
}

const TOPIC_ROUTING = "route tasks to the best lane based on model reliability and latency";
const TOPIC_ROUTING_DUP =
  "route the tasks to the best lane based on the model reliability and latency";
const TOPIC_MEMORY = "agent memory snapshots capture drift between entrypoint and snapshot files";
const TOPIC_INVENTORY = "inventory json is the single source of truth for machines and providers";
const TOPIC_VERIFY = "verify edit runs lint and test commands returning structured failures";

// ---------------------------------------------------------------------------
// Budget respected
// ---------------------------------------------------------------------------

test("selectContext never exceeds the token budget", () => {
  const candidates = [
    candidate("a", TOPIC_ROUTING, 40),
    candidate("b", TOPIC_MEMORY, 40),
    candidate("c", TOPIC_INVENTORY, 40),
    candidate("d", TOPIC_VERIFY, 40),
  ];

  const result = selectContext({ candidates, tokenBudget: 100 });
  assert.ok(result.selected.length >= 1, "should select at least one candidate");
  assert.ok(result.selected.length <= 2, "only two 40-token items fit a 100-token budget");
  const total = result.selected.reduce((sum, s) => sum + s.tokens, 0);
  assert.equal(result.tokensEstimated, total);
  assert.ok(result.tokensEstimated <= 100, `tokensEstimated ${result.tokensEstimated} > 100`);
});

test("selectContext skips oversized candidates but still fills with smaller ones", () => {
  const candidates = [candidate("huge", TOPIC_ROUTING, 500), candidate("small", TOPIC_MEMORY, 20)];
  const result = selectContext({ candidates, tokenBudget: 100 });
  const ids = result.selected.map((s) => s.id);
  assert.ok(!ids.includes("huge"), "candidate larger than the budget must be skipped");
  assert.ok(ids.includes("small"), "smaller candidate should still be selected");
});

test("selectContext estimates tokens from text when tokens is omitted", () => {
  const text = "x".repeat(400); // ~100 tokens
  const result = selectContext({
    candidates: [{ id: "a", text }],
    tokenBudget: 99,
  });
  assert.equal(result.selected.length, 0, "estimated 100 tokens must not fit a 99 budget");
  assert.equal(estimateTokens(text), 100);

  const fits = selectContext({ candidates: [{ id: "a", text }], tokenBudget: 100 });
  assert.equal(fits.selected.length, 1);
});

// ---------------------------------------------------------------------------
// Diversity: near-duplicates not co-selected
// ---------------------------------------------------------------------------

test("near-duplicate candidates are not co-selected even when budget allows", () => {
  const candidates = [
    candidate("routing-1", TOPIC_ROUTING, 20),
    candidate("routing-2", TOPIC_ROUTING_DUP, 20),
    candidate("memory", TOPIC_MEMORY, 20),
    candidate("inventory", TOPIC_INVENTORY, 20),
  ];

  // Budget fits all four; the near-duplicate pair must not both make the cut.
  const result = selectContext({
    candidates,
    tokenBudget: 1000,
    query: "routing memory inventory",
  });

  const ids = new Set(result.selected.map((s) => s.id));
  assert.ok(
    !(ids.has("routing-1") && ids.has("routing-2")),
    `near-duplicates co-selected: ${[...ids].join(", ")}`
  );
  assert.ok(ids.has("routing-1") || ids.has("routing-2"), "one of the pair should be selected");
  assert.ok(ids.has("memory"), "distinct topic should be selected");
  assert.ok(ids.has("inventory"), "distinct topic should be selected");
});

test("query relevance steers selection toward matching candidates", () => {
  const candidates = [
    candidate("memory", TOPIC_MEMORY, 30),
    candidate("routing", TOPIC_ROUTING, 30),
  ];
  // Budget only fits one; the query should decide which.
  const result = selectContext({
    candidates,
    tokenBudget: 30,
    query: "route tasks to the best lane",
    weights: { relevance: 3, coverage: 1, diversity: 1 },
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "routing");
});

test("explicit candidate relevance overrides the query signal", () => {
  const candidates: ContextCandidate[] = [
    { id: "low", text: TOPIC_ROUTING, tokens: 30, relevance: 0.01 },
    { id: "high", text: TOPIC_MEMORY, tokens: 30, relevance: 0.99 },
  ];
  const result = selectContext({
    candidates,
    tokenBudget: 30,
    query: TOPIC_ROUTING, // would favor "low" if relevance were query-derived
    weights: { relevance: 5, coverage: 1, diversity: 1 },
  });
  assert.equal(result.selected[0].id, "high");
});

// ---------------------------------------------------------------------------
// Lazy-greedy matches naive greedy
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random text generator (LCG) for fixture variety. */
function makeGeneratedCandidates(count: number): ContextCandidate[] {
  const vocab = [
    "route",
    "lane",
    "model",
    "memory",
    "snapshot",
    "inventory",
    "provider",
    "task",
    "budget",
    "token",
    "verify",
    "lint",
    "test",
    "drift",
    "machine",
  ];
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const out: ContextCandidate[] = [];
  for (let i = 0; i < count; i += 1) {
    const words: string[] = [];
    const len = 5 + (next() % 8);
    for (let w = 0; w < len; w += 1) {
      words.push(vocab[next() % vocab.length]);
    }
    out.push({ id: `gen-${i}`, text: words.join(" "), tokens: 10 + (next() % 30) });
  }
  return out;
}

test("lazy-greedy matches naive greedy on small sets", () => {
  const scenarios = [
    {
      candidates: [
        candidate("a", TOPIC_ROUTING, 20),
        candidate("b", TOPIC_ROUTING_DUP, 20),
        candidate("c", TOPIC_MEMORY, 20),
        candidate("d", TOPIC_INVENTORY, 20),
        candidate("e", TOPIC_VERIFY, 20),
      ],
      tokenBudget: 60,
      query: "routing and memory",
    },
    {
      candidates: makeGeneratedCandidates(12),
      tokenBudget: 120,
      query: "route token budget",
    },
    {
      candidates: makeGeneratedCandidates(8),
      tokenBudget: 1000,
      query: undefined,
    },
    {
      // Identical texts and costs: pure tie-breaking territory.
      candidates: [
        candidate("t0", TOPIC_MEMORY, 10),
        candidate("t1", TOPIC_MEMORY, 10),
        candidate("t2", TOPIC_MEMORY, 10),
      ],
      tokenBudget: 100,
      query: undefined,
    },
  ];

  for (const scenario of scenarios) {
    const lazy = selectContext(scenario);
    const naive = naiveGreedySelect(scenario);
    assert.deepEqual(
      lazy.selected,
      naive.selected,
      `lazy and naive selections diverged for budget ${scenario.tokenBudget}`
    );
    assert.equal(lazy.tokensEstimated, naive.tokensEstimated);
    assert.ok(
      lazy.evaluations <= naive.evaluations,
      `lazy (${lazy.evaluations} evals) should not evaluate more than naive (${naive.evaluations})`
    );
  }
});

test("lazy-greedy matches naive greedy in fill-the-budget mode (minGain -Infinity)", () => {
  const scenario = {
    candidates: makeGeneratedCandidates(10),
    tokenBudget: 150,
    minGain: Number.NEGATIVE_INFINITY,
  };
  const lazy = selectContext(scenario);
  const naive = naiveGreedySelect(scenario);
  assert.deepEqual(lazy.selected, naive.selected);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("selectContext is deterministic for fixed inputs", () => {
  const scenario = {
    candidates: makeGeneratedCandidates(15),
    tokenBudget: 200,
    query: "verify drift snapshot",
  };
  const first = selectContext(scenario);
  const second = selectContext(scenario);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Pluggable similarity
// ---------------------------------------------------------------------------

test("a custom similarity signal is honored", () => {
  const candidates = [
    candidate("a", "alpha", 10),
    candidate("b", "beta", 10),
    candidate("c", "gamma", 10),
  ];
  // Custom signal declares a and b identical, c unrelated; relevance flat.
  const similarity = (x: string, y: string): number => {
    if (x === y) return 1;
    const pair = [x, y].sort().join("|");
    return pair === "alpha|beta" ? 1 : 0;
  };
  const result = selectContext({ candidates, tokenBudget: 100, similarity });
  const ids = new Set(result.selected.map((s) => s.id));
  assert.ok(
    !(ids.has("a") && ids.has("b")),
    "custom signal marks a/b as duplicates; both must not be selected"
  );
  assert.ok(ids.has("c"), "unrelated candidate should be selected");
});

test("default lexical similarity behaves sensibly", () => {
  assert.equal(lexicalSimilarity("alpha beta", "alpha beta"), 1);
  assert.equal(lexicalSimilarity("alpha", "gamma"), 0);
  const partial = lexicalSimilarity("alpha beta", "alpha gamma");
  assert.ok(partial > 0 && partial < 1, `partial overlap should be in (0,1), got ${partial}`);
  assert.equal(lexicalSimilarity("", "anything"), 0);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty candidates and non-positive budgets return empty results", () => {
  assert.deepEqual(selectContext({ candidates: [], tokenBudget: 100 }), {
    selected: [],
    tokensEstimated: 0,
    evaluations: 0,
  });
  assert.deepEqual(
    selectContext({ candidates: [candidate("a", "text", 5)], tokenBudget: 0 }).selected,
    []
  );
  assert.deepEqual(
    selectContext({ candidates: [candidate("a", "text", 5)], tokenBudget: -5 }).selected,
    []
  );
});
