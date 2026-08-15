# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.64.0] — 2026-08-14

A large release. The tool surface grew from 33 to 45 always-registered tools
plus 2 optional lifecycle hooks, and every tool now declares its safety
annotations. Supervision gained goal contracts, task leases, a dependency
graph, and three distinguished terminal states. A repo-wide audit and the
fixes that followed are recorded in `MANUAL.md` §11.

### Added

- **`xx` CLI.** A pipeable command surface over the same runtime the MCP server
  uses, shipped as a second bin alongside `mcp-server`. Structured JSON on
  stdout, structured errors and non-zero exit codes on failure.
- **Context-tiered rules pack.** 11 engineering rule books vendored from
  `ciembor/agent-rules-books` (MIT) in full/mini/nano tiers under
  `packs/rules/`. `coverage.json` maps every skill and agent to the books that
  apply, with `books: []` as an explicit "no book changes this decision"
  decision. Enforced by `npm run rules:check`, wired into `verify`.
- **Nano guidance tiers.** ~1–2KB decision-rules-only variants of the five
  critical surfaces — `execution-orchestrator` and `fast-build` (agents),
  `review-code`, `debug-investigate`, `deploy-ship` (skills) — for lanes whose
  context window cannot hold the canonical file. `npm run nano:check` pins each
  canonical file's hash, so a canonical edit without a nano review fails CI.
- **Three planning and research skills**: `plan-decision-map` (multi-session
  decision tickets backed by the task tools, one decision resolved per session),
  `interrogate-plan` (one question at a time with a recommended answer, owning
  the questioning phase the `plan-*` skills delegate), and `research-deep`
  (budget-bounded search → read → reason → reflect loop with an explicit
  knowledge-gaps queue and completion-judge-gated termination).
- **`build_repo_map`** — repository structure mapping with token-budgeted
  fitting, landed from the stranded `ralph/queue-xx01b` branch.
- **`verify_edit`** — post-edit verification behind the guarded exec gate.
- **`route_review`** — prefers a review lane whose model differs from the
  author's, collapsing to same-model review with an explicit shortfall note.
- **`score_candidates`** and **`review_to_continuation`.**
- **`supervisor_force_synthesis`** and the `force_synthesized` terminal state,
  sitting between success and failure with an evidence-only synthesis prompt.
- **`supervisor_emit_handoff_prompt`** — structured failover handoff
  (state-not-instructions, Traps & Dead Ends, verify-don't-trust preamble,
  secret redaction).
- **Goal contracts.** Optional `goalContract` on task registration; completion
  gated on the stop condition, with `verify_edit` evidence required when
  `validationCmd` is set.
- **Task leases.** Optional `{ expiresAt, revoked }` lease on task registration.
  Failover revokes linked leases, and a write-back against a dead lease returns
  a structured `lease_revoked` rejection without writing.
- **MCP lifecycle hook tools.** `_Stop` and `_PostCompact`, registered only
  under `XX_STACK_HOOK_TOOLS=1` and absent from `tools/list` by default.
- **Compare-and-swap memory writes.** Optional `expectedHash` precondition on
  snapshot apply and superseded marking; a mismatch returns a structured
  `write_conflict` with the current hash and writes nothing. The MCP tools and
  the `xx memory` commands share one runtime function, so the CLI surfaces
  conflicts as exit code 5.
- **Submodular context selection.** Lazy-greedy relevance/coverage/diversity
  selection as a pure zero-dependency runtime, used by the repo map for budget
  fitting. `agent_memory_get` gained optional `tokenBudget`/`query`, and
  compaction now emits a distillation prompt and supersedes entries in place
  rather than deleting them.
- **Fleet-wide catastrophic-command denylist**, running ahead of the exec
  allowlists. `guardrails:check` pins the pattern-file hash so a pattern change
  without a test update fails CI.
- **Array-accepting routing tools.** `route_task`, `route_architect_editor`, and
  `route_competitive_task` accept `string | string[]` with position-aligned,
  concurrency-capped results.
- **Optional inventory-declared local reader service.** Off by default, never a
  routing lane, never dialed by the MCP server; `research-deep` prefers it and
  degrades to plain fetch.
- **`MANUAL.md`** — full repository reference and the audit defect register.
- **`npm run ci:parity`** — asserts every gate in the `verify` chain has a step
  in `ci.yml`, with exemptions required to carry a reason and checked for
  staleness in both directions. Self-enforcing: it is itself in both.
- `repository.directory` on `@xx-stack/mcp-server`, so its `repository` field
  resolves to the workspace rather than the repo root.
- **`craft/layering.md`** — thirteenth craft section, and the first with no
  upstream: stacking contexts, why raising `z-index` does not work, a named
  layering ladder, the top layer via `dialog.showModal()`, and why one shadow
  ladder cannot serve dark mode. Bound to no skill, like `design-intent.md`.
- **Four further craft sections**, each filling a gap measured against the
  skills this pack already ships rather than proposed on taste. All bound to no
  skill; `craft/` now reports 17 shipped sections.
  - **`craft/data-visualization.md`** — resolves a live contradiction as well as
    a gap. Eight workflow skills name a chart type and ten examples contain
    plotted geometry, while craft carried one sentence about charts. Worse, a
    six-series chart had no legal route: `color.md` caps `--accent` at 2 visible
    uses, `accent-overuse` fires at 6, `raw-hex` fires at 12, and no categorical
    tokens existed anywhere in the pack. The ruling — series colour is an
    *identity* role, accent colour an *attention* role, so the accent cap never
    applied to `--series-N` — leaves `color.md` unedited and uncontradicted.
    Carries the validation thresholds and the token contract, not a palette.
  - **`craft/responsive.md`** — the rulebook behind a gate that already warns
    "No @media query found" with nothing standing behind it. Reflow as a WCAG
    1.4.10 legal floor, mobile-first in rem, container queries for components,
    `clamp()` and its two traps, 2D-content handling, `dvh`/`svh`.
  - **`craft/theming.md`** — the mechanism `color.md` §Dark themes does not
    cover: the three-state light/dark/**system-default** problem, the
    `color-scheme` property, the `:not([data-theme="light"])` guard, and
    reference/system/component token layering. A companion file, because
    `color.md` is vendored byte-identical.
  - **`craft/iconography.md`** — gives the P0 emoji-as-icons ban a named
    alternative, which it had never had: inline SVG on one grid at one stroke,
    optical sizing, and the decorative-versus-meaningful naming decision.

### Changed

- **Exec gate hardening.** `guardedExecFile` spawns detached on POSIX and sweeps
  the process group with SIGTERM-then-SIGKILL on every exit path, so a forking
  test runner no longer strands orphans; Windows degrades to direct-child
  signalling. `verify_edit` keeps the full capture in a per-session scratch ring
  outside the repo and returns a head+tail view.
- **`routeArchitectEditor`** now honors `preferArchitectHost` and
  `preferEditorHost`, which were declared in the spec but previously ignored.
- **Skill contract deltas folded into overlapping skills**: a red-command gate
  before hypotheses plus tagged instrumentation and bisection escalation in
  `debug-investigate`; pinned baseline, independent standards/spec axes, and
  verbatim-report integrity in `review-code` and the `reviewer` agent;
  deep-module vocabulary in `plan-architecture`; spec hygiene and an instant
  gate in `plan-feature`; seams and anti-patterns in `test-qa`; a
  SHA-verified-live done criterion in `deploy-ship` and `ops-deploy-land`.
- **Dependency budget and web-standard-API doctrine** documented in
  `CONTRIBUTING.md`.

### Fixed

- Prettier and lint cleanup across the `mcp-server` sources.
- `verify_edit` is now driven through the registered tool in tests rather than
  only through its helpers.
- Hermes TODO reconciled against what actually shipped.
- **Six gates ran in `verify` but never in CI**: `rules:check`, `nano:check`,
  `guardrails:check`, `design:systems-lint`, `design:craft-refs` and
  `design:anti-slop-test`. All six now run on every push and pull request.
  CONTRIBUTING.md had asserted the two suites were equivalent while they were
  not; the paragraph is corrected and the invariant is now a gate rather than a
  claim.
- **`design-systems/material/DESIGN.md` did not describe Material.** Its
  palette, fonts, type scale, spacing and motion were corrected against
  `mui/material-ui` at `48c6663a`. Recorded in `packs/design/manifest.json`
  under `resolvedContentDefects`.
- `packs/design/README.md` said `design:craft-refs` and `design:anti-slop-test`
  were not wired into `verify`. Both had been for some time.
- `packs/design/README.md` counted five contributing upstreams while its own
  table listed six plus a carve-out.

### Security

- **`npm audit --omit=dev --audit-level=high` now gates CI.** Seven advisories
  against shipped transitive dependencies (3 high, 3 moderate, 1 low — `hono`,
  `fast-uri`, `ip-address`, `qs`, `body-parser`, `express-rate-limit`,
  `@hono/node-server`, all reached through `@modelcontextprotocol/sdk`) were
  resolved by a lockfile update. Shipped dependencies now audit clean.
- **`SECURITY.md`** — private vulnerability reporting channel, supported
  versions, and an explicit in-scope/out-of-scope boundary for a project whose
  attack surface is an execution policy and a routing decision.
- **`.github/dependabot.yml`** — weekly npm and GitHub Actions updates, with
  majors on the two shipped dependencies held back for a human.
- **A maintainer tailnet name shipped in the repository and in the npm
  package.** The host `skippy-debian-5090` was a real Tailscale MagicDNS
  address, carried in `inventory.json` as `network.address`, in both generated
  registries, in the Hermes lanes, in seven docs, and — because
  `runtime-constants.json` is in the package's `files` — in anything published
  from this tree. It is now `gpu-rig`, a placeholder the inventory tells you to
  replace, across 62 occurrences in 18 files, including the `skippyDebian5090`
  constant, its TypeScript type, and the `XX_STACK_HOST_SKIPPY_DEBIAN_5090`
  setup variable. The 1.63.0 entry below claims "No private network addresses,
  tailnet names, or absolute home paths in the repository"; that claim was
  false when written, and is true as of this release. Re-checked at the same
  time: no absolute home paths, no RFC1918 or CGNAT addresses, and no
  `*.ts.net` names remain in tracked files.
- Known and deliberately not gated: `eslint` is pinned at `8.57.1`, which is
  end-of-life and pulls a `js-yaml` carrying two high advisories. Dev-only, so
  it does not ship; clearing it means an ESLint 9 flat-config migration.

## [1.63.0] — 2026-07-24

First tagged release of an existing project. The repository was reorganised into three top-level
components and the routing server was made publishable.

### Added

- **Single hardware inventory.** `inventory.json` is the one place you describe
  machines, how they are reached, and which inference runtimes they run. It
  generates the TypeScript platform registries and the Hermes lane config:
  `npm run inventory:sync`, with `npm run inventory:check` enforcing freshness
  in CI.
- **Tailscale auto-discovery.** `npm run inventory:scan` probes online peers for
  Ollama, sglang, vLLM, llama.cpp and LocalAI, records the models each serves,
  and with `--ssh` reads real GPU specs via `nvidia-smi`. Everything discovered
  is written **disabled**; `inventory:enable` / `inventory:disable` turn lanes on
  deliberately. Rescans are idempotent and never delete a machine that has gone
  quiet.
- **Hermes as a routing lane.** A `hermes-proxy` host, disabled by default, lets
  xx-stack delegate lane selection to the Hermes control plane through one
  OpenAI-compatible loopback endpoint.
- `npm run verify` — one gate covering layout, agent-mirror sync, stack-source
  drift, inventory freshness, and every test suite.
- `npm run drift:check` — catches structural divergence between the
  host-agnostic and OpenCode-specialised stack sources.
- Published package `@xx-stack/mcp-server`, self-contained and usable via `npx`.

### Changed

- Three top-level components: `xx-stack/` (core, source of truth),
  `opencode-orchestration/` (OpenCode install layer), `hermes-orchestration/`
  (Python control plane). The first two share one `mcp-server/`, `scripts/` and
  `packs/` by symlink rather than keeping duplicate copies.
- The shipped example registry now enables localhost Ollama by default, so a
  fresh clone with `ollama serve` running works with no edits.
- Design pack workflow skills moved to `packs/design/workflow-skills/`, removing
  a directory named after its consumer.
- Setup enriches the live registry at `~/.config/opencode/xx-stack-platforms.json`
  rather than mutating generated files.

### Fixed

- **`setup.sh` never completed.** It called four functions that have never
  existed in this repository and exited 127 partway through.
- **The MCP server exited silently when launched through a symlink.** Its
  direct-execution guard compared paths lexically, so `main()` never ran and the
  process exited 0 — indistinguishable from a crash to callers.
- **The registry was unreachable by its own server.** Lookup only searched
  `.opencode/`, so `xx-stack/runtime/platforms.json` was never found.
- Two competing host-discovery paths, one silently overwriting the other;
  824 lines of superseded shell removed.
- Invalid `endpointFamily: "catalog"` in the shipped registry.
- Cloud-escalation policy, self-hosted-first defaults, and a scrubbed private
  Tailscale IP restored after an accidental revert.
- `DESIGN-CATALOG.md` is deterministic; it embedded a timestamp that made every
  regeneration produce a diff.
- Node 20 compatibility for the test runner.

### Security

- Cloud routing is fail-safe: absent or `false` `cloudEscalation.optIn` disables
  cloud entirely, even when every self-hosted lane is unreachable.
- No private network addresses, tailnet names, or absolute home paths in the
  repository.

[1.64.0]: https://github.com/piercingxx/xx-stack/releases/tag/v1.64.0
[1.63.0]: https://github.com/piercingxx/xx-stack/releases/tag/v1.63.0
