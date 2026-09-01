# Rules pack — context-tiered rule books

Decision-rule sets distilled from classic software-engineering books, vendored
from [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books)
(MIT, commit `9c8763613514e4047d75c089533e09bc4b493c28`). The upstream MIT
license is included as [LICENSE](LICENSE) and covers every book directory in
this pack. Book content is vendored byte-for-byte; do not reformat it
(`packs/` is in `.prettierignore` for exactly this reason).

## Layout

Each book directory ships three tool-agnostic tiers:

- `<book>.md` — `full`: canonical complete reference (~11–62 KB)
- `<book>.mini.md` — `mini`: recommended default for real task use (~4–7 KB)
- `<book>.nano.md` — `nano`: compact fallback for tight context budgets (~1–2.5 KB)

## Machine-readable indexes

- [`manifest.json`](manifest.json) — per book: tier paths, estimated tokens
  (bytes/4 rounded), and compatibility edges (complementary / overlapping /
  conflicting) transcribed from upstream `docs/COMPATIBILITY.md`.
- [`coverage.json`](coverage.json) — one entry per runtime skill and agent,
  mapping it to its relevant book set and a `defaultTier` recommendation.
  `books: []` is an explicit "nothing applies" decision, not an omission.

Hosts and routers pick the tier from the target lane's context window and any
token budget; `defaultTier` is the no-budget-info fallback (usually `mini`,
`nano` for tight lanes). Never load two books the manifest marks conflicting;
where it marks overlap, load one.

## Not vendored (deliberate)

- `domain-driven-design`, `implementing-domain-driven-design` — upstream marks
  all three DDD variants as overlapping (pick one); this pack carries
  `domain-driven-design-distilled` only.
- `patterns-of-enterprise-application-architecture` — carries upstream's only
  conflicting edges (vs. DDD and IDDD) and no coverage mapping demanded it.

## Drift check

`npm run rules:check` (`scripts/check-rules-coverage.mjs`) asserts
that `coverage.json` lists exactly the current contents of `runtime/skills/`
and `runtime/agents/`, that every referenced book exists in `manifest.json`,
that manifest tier paths exist on disk, and that no coverage entry pairs
conflicting (or uncollapsed overlapping) books.
