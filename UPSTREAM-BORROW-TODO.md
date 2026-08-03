Upstream Borrow TODO

Ideas worth pulling into xx-stack, harvested from a review of Orca (stablyai), Aider (Aider-AI), and Titus-AI (ChrisTitusTech). Ordered by value. Each task is self-contained: goal, rationale, files, approach, acceptance criteria, and how to verify.

Guiding constraint: xx-stack is a headless, local-first MCP control plane. It routes, supervises, and qualifies — it does not become a desktop app. Every task below respects that: no GUI, cloud stays opt-in, inventory.json stays the single source of truth, and the full npm run verify pipeline must stay green.

Ground rules for whoever executes (Skippy):

    New MCP tools register via server.tool(name, description, zodSchema, handler) and are wired in xx-stack/mcp-server/src/index.ts through a registerXxxTools(server, deps) function (see routing_tools.ts for the canonical shape).
    Tests use the built-in node:test runner (see reliability.test.ts). Add a *.test.ts beside new runtime files.
    The MCP server is ESM ("type": "module") — import local files with the .js extension. Shared xx-stack/scripts/*.js helpers are CommonJS; ESM entrypoints use .mjs.
    After any change touching inventory.json/schema/registries, run npm run inventory:sync then npm run inventory:check (CI fails on drift).
    Final gate for every task: npm run verify (layout + agents + drift + inventory + tests + hermes).

Tier 1 — High value, direct fit
1. Repo map / context-budget tool (from Aider — biggest gap)

Goal. Add an MCP tool that, given a repo root and a token budget, returns the most relevant slice of the codebase (ranked files + key symbols) to feed into a routed task.

Why. xx-stack routes a task to a machine but never decides what code context goes in the prompt. Aider's repo map (tree-sitter parse → symbol graph → PageRank-style ranking → fit to token budget) is the single highest-value borrow, and it matters most for the small local models this stack targets, where the context window is tight.

Files.

    New: xx-stack/mcp-server/src/repo_map_runtime.ts (pure logic + ranking)
    New: xx-stack/mcp-server/src/repo_map_tools.ts (build_repo_map tool)
    New: xx-stack/mcp-server/src/repo_map_runtime.test.ts
    Edit: xx-stack/mcp-server/src/index.ts (register the tool group)
    Edit: xx-stack/mcp-server/package.json if a parser dep is added

Approach.

    Tool build_repo_map, args: { root: string, tokenBudget?: number (default 8000), focusPaths?: string[], includeSymbols?: boolean }.
    Phase 1 (ship first, no new deps): rank by a cheap signal — git recency + path proximity to focusPaths + import/reference counts via regex — and return a ranked file list with byte/line ranges that fit the budget.
    Phase 2 (optional, gated behind a flag): tree-sitter parse for a real symbol graph and PageRank ranking. Keep the dep optional; if the parser isn't installed, fall back to Phase 1 cleanly (this stack must degrade gracefully offline).
    Return shape: { files: [{ path, score, ranges, symbols? }], tokensEstimated, method: "heuristic"|"treesitter" }.
    Respect .xxignore (already a repo convention) and .gitignore.

Acceptance criteria.

    Returns a budget-respecting ranked map on this repo in <2s for the heuristic path.
    focusPaths measurably reorders results toward the focus.
    No network calls; works with zero optional deps installed (heuristic fallback).
    Unit tests cover budget truncation, ignore-file filtering, and focus reordering.

Effort: M–L. Risk: Low (additive, read-only).
2. Architect → editor two-model split (from Aider — extends the routing core)

Goal. A routing pattern where one model reasons/plans the change and a second, cheaper/faster model applies it in a strict edit format — each potentially on a different machine.

Why. This is xx-stack's own thesis (heterogeneous machines, heterogeneous roles) applied one level deeper: reason on the GPU box, apply on the laptop. You already have a plan-architecture skill and a plan agent, but nothing that splits a single edit into architect+editor at the routing layer.

Files.

    Edit: xx-stack/mcp-server/src/routing_runtime.ts (add routeArchitectEditor)
    Edit: xx-stack/mcp-server/src/routing_tools.ts (new route_architect_editor tool)
    Edit: xx-stack/mcp-server/src/routing_runtime.test.ts (or add one)
    Reference: hermes-orchestration/model-qualification-matrix.md, xx-stack/runtime/model-recommendations.json

Approach.

    Tool route_architect_editor, args: { description, preferArchitectHost?, preferEditorHost? }.
    Reuse existing tier selection: pick a reasoning-strong lane for the architect (maps to the coder-deep alias / reasoning role) and a low-latency lane for the editor (maps to coder-fast). Both drawn from the live registry.
    Output: { architect: {host, model, reasoning}, editor: {host, model, reasoning}, fallback } mirroring the existing route_task result shape so callers stay uniform.
    Do not execute edits here — this stays a routing recommendation, consistent with the rest of the server. Execution is the agent's job.

Acceptance criteria.

    Given a registry with distinct deep/fast lanes, architect and editor resolve to different, appropriate lanes; with only one lane, both collapse to it with clear reasoning.
    Cloud still excluded unless XX_STACK_ALLOW_CLOUD=1 / opt-in (reuse existing gate).
    Tests cover: two-lane split, single-lane collapse, cloud-excluded-by-default.

Effort: M. Risk: Low. Depends on: nothing (Task 1 optional synergy).
3. Per-model edit-format qualification + auto lint/test loop (from Aider)

Goal. (a) Record which edit format each model reliably produces, alongside the existing reliability fields. (b) Add a tool that, after an edit, runs the project's linter/tests and returns a structured pass/fail + failure payload for a continuation prompt.

Why. You already qualify models by toolCallReliability / jsonModeReliability in inventory.schema.json, and model-recommendations.json picks models per provider — but not which edit format per model. Aider shows edit-format choice is the single biggest lever on local-model editing reliability. The lint/test loop turns your existing "run tests" prompt guidance into an actual closed loop.

Files.

    Edit: inventory.schema.json — add to the model definition (which already has additionalProperties: true):
        editFormat: enum ["whole","diff","diff-fenced","udiff"]
        editFormatReliability: enum ["validated","unverified","unreliable"]
    Edit: xx-stack/scripts/generate-registries.mjs — propagate the new fields into the generated registries.
    Edit: inventory.example.json and inventory.json — add the fields to a couple of models as examples (unverified default).
    New: xx-stack/mcp-server/src/verify_edit_tools.ts — tool verify_edit { cwd, lintCmd?, testCmd? } → runs commands, returns { lint: {ok, output}, test: {ok, output} }.
    Edit: xx-stack/mcp-server/src/index.ts — register it.
    New: matching *.test.ts.

Approach.

    verify_edit shells out via the existing execution-policy path (execution_policy.ts / validateExecRequest) — do not bypass the policy gate.
    Truncate captured output to a sane cap; surface the failing tail (that's what a continuation prompt needs). Wire the output so it can feed supervisor_emit_continuation_prompt.
    Edit-format fields are advisory metadata now; route_task reasoning can mention the chosen model's editFormat so the caller knows which format to request.

Acceptance criteria.

    Schema accepts the new fields; npm run inventory:check passes after inventory:sync.
    verify_edit returns structured results for a passing and a failing command, respects execution policy, and truncates output.
    Tests cover both new fields (schema round-trip) and the tool's pass/fail shaping.

Effort: M. Risk: Low–Med (touches schema + generator → run drift/inventory checks).
Tier 2 — Solid, extends existing strengths
4. Competitive worktree fan-out + merge-the-winner (from Orca)

Goal. Route the same prompt to N lanes, each executing in its own isolated git worktree, then a scoring/diff step recommends a winner to merge.

Why. Orca's signature workflow, and complementary to ensemble-consensus (which merges text answers, not competing code changes). You're already half-plumbed: task_runtime.ts / task_tools.ts carry worktreePath per task.

Files.

    Edit: xx-stack/mcp-server/src/routing_runtime.ts / routing_tools.ts — new route_competitive_task producing N assignments, each with a distinct worktree path.
    Edit: xx-stack/mcp-server/src/task_tools.ts — helper to register the N worktree-linked tasks.
    New: a score_candidates tool (or extend supervisor) that takes N diffs and returns a ranked recommendation with rationale. Keep the merge itself a human/agent action.
    New: *.test.ts.

Approach.

    route_competitive_task { description, fanout: 2..5 } → N lane assignments + N suggested worktree paths (don't create worktrees inside the MCP server; return the plan and let the agent/CLI create them, matching the headless contract).
    Scoring: start heuristic (diff size, tests-passing via Task 3's verify_edit, lint clean), leave a hook for a model-judged score later.

Acceptance criteria.

    Produces N distinct lane+worktree assignments; collapses gracefully when fewer lanes exist than requested fanout (log the shortfall — no silent truncation).
    Scoring returns a deterministic ranking given fixed inputs; tested.

Effort: L. Risk: Med. Depends on: Task 3 (verify_edit) for the strongest scoring signal.
5. Per-lane usage / cost telemetry (from Orca)

Goal. Track tokens (and estimated cost for cloud lanes) per lane, so cloud-escalation decisions become quantitative.

Why. Orca does account/usage tracking across providers. You have telemetry.json (currently {enabled:false, fields:[ts,skill,outcome,durationMs]}) and a cloud opt-in gate — extend telemetry so "turn on cloud" can report "this cost $X."

Files.

    Edit: xx-stack/runtime/telemetry.json — add optional fields ["lane","tokensIn","tokensOut","costUsd"] (keep enabled:false default; opt-in only).
    Edit: xx-stack/mcp-server/src/observability_tools.ts — accept and persist these fields.
    Reference: xx-stack/runtime/TELEMETRY-POLICY.md — update the policy doc to cover cost fields.

Approach.

    Cost is estimate-only, derived from a small per-model rate table in runtime/ (local lanes = 0). No new network calls.
    Keep everything local-file, respecting TELEMETRY-POLICY.md and the retention window.

Acceptance criteria.

    Telemetry stays off by default; when enabled, per-lane token/cost rows are written to the existing JSONL sink; policy doc updated; tests/verify green.

Effort: S–M. Risk: Low.
6. Annotated diff-review → continuation loop (from Orca)

Goal. A tool that takes a diff plus reviewer notes and produces a structured continuation directive back to the agent.

Why. Orca routes inline review comments back into the agent. Your supervisor already emits continuation prompts (supervisor_emit_continuation_prompt) — this is a thin, natural extension that formalizes the review→fix loop.

Files.

    Edit: xx-stack/mcp-server/src/supervisor_tools.ts (or a new review_tools.ts).
    New: *.test.ts.

Approach.

    review_to_continuation { diff, notes: [{path, line?, comment}] } → { continuationPrompt, mustAddress: [...] }, reusing the existing continuation-prompt formatter.

Acceptance criteria. Deterministic prompt from fixed input; integrates with the existing supervisor continuation path; tested.

Effort: S. Risk: Low. Depends on: loosely on Task 3 (feed lint/test failures as notes).
Tier 3 — Optional / low priority
7. Optional tool-output compression adapter (from Titus-AI's RTK)

Goal. An optional pass that compresses verbose command/tool output before it reaches a model's context.

Why. For small-context local models, trimming noisy output is a real token win. Titus-AI ships this as a Rust proxy (RTK); xx-stack should do it as an optional in-process helper, not a required dependency.

Files.

    New: xx-stack/mcp-server/src/output_compaction.ts — pure function compactOutput(text, {maxLines, keepHeadTail}).
    Wire it as opt-in into verify_edit (Task 3) and any high-volume tool output.

Approach. Head/tail retention + collapse of repeated lines + drop of known-noise patterns (progress bars, ANSI). Off by default; caller opts in. Log what was dropped (no silent truncation).

Acceptance criteria. Reversible-enough summary (head+tail preserved), configurable cap, unit-tested, off by default.

Effort: S. Risk: Low.
Explicitly NOT doing (out of scope for a headless control plane)

    Embedded Chromium / "Design Mode", terminal splits, mobile companion apps, computer-use desktop automation (all Orca GUI concerns).
    Aider's interactive chat REPL / voice — xx-stack routes and supervises; it is not the editing REPL.
    Titus-AI's skills/plan-implement framework — you already have this (runtime/, packs/, design-skills/); no need to duplicate.

Suggested execution order

1 → 2 → 3 (Tier 1, each independently shippable; 3 unlocks scoring for 4) → 5 → 6 (small, low-risk) → 4 (largest) → 7 (optional).
Definition of done (every task)

    npm run verify green (layout, agents, drift, inventory, tests, hermes).
    New runtime logic has a *.test.ts.
    No new required network calls; cloud stays opt-in; offline degradation is clean.
    inventory.json remains the single source of truth; docs updated where behavior changed.

From mattpocock/skills (reviewed 2026-07-30)

Harvest from mattpocock/skills. Most of that repo overlaps skills xx-stack already ships (debugging, review, planning, TDD, research), so the default here is fold techniques into our skills, not import new ones. Two exceptions are worth adopting as new skills: wayfinder and grill.

These are prompt/skill-layer tasks — no MCP server code, so the ground rules are lighter: edit runtime/skills/*/SKILL.md, keep runtime/SKILLS.md and any adapters/skills/*.prompt.md mirrors in sync (canonical repo skill wins), and finish with npm run verify.
Tier 1 — New skills

Naming: house convention is verb-first / domain-first (plan-architecture, debug-investigate, review-code) — the upstream names (wayfinder, grill) are branding and do not carry over.
8. plan-decision-map — multi-session decision-map planning (upstream: "wayfinder")

Goal. New skill runtime/skills/plan-decision-map/SKILL.md: for large foggy projects, build a persistent map of decision tickets, then resolve one decision per session until the path is clear. Plan, don't do — output is decisions, handed off to build skills when the fog clears.

Why. Nothing in xx-stack plans across sessions; plan-* skills produce a one-shot artifact and the autonomous TODO loop executes a flat list. Wayfinder's model — map as index, tickets as single decision questions sized to one context window, "fog of war" items that only graduate to tickets once the question can be stated precisely — is the missing layer above AUTONOMOUS_TODO_LOOP.md.

Approach.

    Adapt the tracker: mattpocock assumes a GitHub/Linear issue tracker; xx-stack should back the map with the MCP task tools (task_tools.ts) — map as a parent task, decision tickets as child tasks with blocking edges.
    Keep his rules that earn their keep: one decision per session; claim before work; one-line answers on the map, detail linked; refer to tickets by title.
    Ticket types research | prototype | interrogate | task; research tickets may fan out in parallel via route_parallel_tasks (routing tie-in he doesn't have).
    Follow the house contract: activation contract, evidence-first, explicit degradation (no task tools available → map as a repo markdown file).

Acceptance criteria. Skill passes the SKILLS.md contract; charting and working modes both documented; degrades to file-backed map; SKILLS.md updated.

Effort: M. Risk: Low (prompt-layer only).
9. interrogate-plan — one-question-at-a-time decision interrogation (upstream: "grill")

Goal. New small skill runtime/skills/interrogate-plan/SKILL.md: stress-test a plan or decision by walking its decision tree one question at a time, each question carrying a recommended answer, until no unresolved branches remain.

Why. ideate-product already does this for product ideas (and proves the pattern fits the house style), but there is no generic version for technical decisions, plans, or specs. The valuable rules: one question per message (no bewildering multi-part interrogations); recommend an answer with every question; check the repo/environment for answerable facts instead of asking; the user decides, the skill only asks.

Approach. Write the generic loop; then have plan-feature ("Ask focused questions first") and plan-architecture reference it for their questioning phases instead of restating it. Task 8's interrogate ticket type points here.

Acceptance criteria. Skill ships; plan-feature delegates its question phase to it; no duplicated interview instructions across skills.

Effort: S. Risk: Low. Synergy: Task 8 (ticket type), ideate-product.
Tier 2 — Overlap harvest (edits to existing skills)
10. Fold the good deltas into our overlapping skills

Each sub-item is small and independent; batch as one PR.

    debug-investigate ← diagnosing-bugs: add a feedback-loop-first gate — before generating hypotheses, build a command that goes red on this exact bug and is deterministic, fast, and unattended-runnable ("a 2-second deterministic loop is a debugging superpower"). Our Step 1 says "reproduce"; his stronger form is no hypothesis phase until you have a red command. Also borrow: tag all debug instrumentation with a unique prefix ([DEBUG-a4f2]) so cleanup is a grep, and list bisection/differential-testing as escalation options for hard repros.
    review-code ← code-review: (a) pin a fixed point — resolve the ref and require git diff <ref>...HEAD non-empty before reviewing; (b) split the review into two independent axes — standards (repo conventions) and spec (does it implement the originating issue/spec) — and report per-axis without reranking, so "standards pass, spec fail" stays visible. Natural xx-stack twist: the two axes are independent and can run on two lanes via route_parallel_tasks.
    plan-architecture ← codebase-design: adopt the deep-module vocabulary (confirmed absent today): depth = behaviour per unit of interface learned; seams; the deletion test (if removing a module just makes complexity vanish, it was a pass-through); one adapter = hypothetical seam, two = real; design-it-twice for major interfaces.
    plan-feature / to-spec rule ← keep spec bodies free of file paths and code snippets ("they age poorly") — except the required Critical Files closing section, which stays: it is the builder handoff, not spec content. Preserve prototyped snippets only when they encode a decision better than prose (state machines, schemas, type shapes).
    test-qa ← tdd: before adding regression tests, name the seams under test and confirm them; add the anti-pattern list (tautological assertions, implementation coupling / mocking internals). Note: our verification-failure section is already stronger than his — don't touch it.
    runtime/SKILLS.md contract ← writing-great-skills: add authoring guidance — progressive disclosure (inline what every branch needs, link the rest), positive steering over negation, delete no-op lines, checkable completion criteria per step.

Effort: M total. Risk: Low.
Synergies with the existing tiers above

    His handoff skill (compact context → temp file → suggested next skills) is Task 6's continuation loop seen from the agent side — fold its "reference existing artifacts, don't restate them" and "suggest next skills" rules into the continuation-prompt format when doing Task 6.
    His resolving-merge-conflicts rules ("preserve both intents; never --abort; resolve toward the merge's objective and document the trade-off") belong in the merge step of Task 4's merge-the-winner flow.
    His to-tickets "tracer-bullet" sizing (vertical slice through every layer, fits one fresh context window, declares blocking edges) is exactly the decomposition guidance route_parallel_tasks callers need — cite it in that tool's description or the orchestrator agent prompt.

Explicitly NOT borrowing

    ask-matt, setup-matt-pocock-skills, triage — tracker- and author-specific plumbing.
    implement, tdd, research, code-review as whole skills — covered by fast-build, test-qa, the research agent, and review-code; only the deltas above are worth taking.
    teach, grill-with-docs, domain-modeling — doc/vocabulary workflows with no routing angle; revisit only if a docs-heavy use case appears.

From ciembor/agent-rules-books (reviewed 2026-07-30)

Harvest from agent-rules-books (MIT): 14 classic software-engineering books distilled into decision-rule sets, each shipped in three sizes — full (~13–62KB, reference), mini (~3–8KB, recommended default), nano (~1–2KB, tight context). Plus a compatibility matrix (complementary / overlapping / conflicting pairs) and per-tool loading guidance whose core principle matches ours: use the smallest mechanism that changes the agent's decisions.

The fit is unusually direct: xx-stack's whole premise is heterogeneous lanes with heterogeneous context windows, and this repo is guidance pre-sized for exactly that. Their own eval (structured rules ~74/100 vs. bare book citation ~46/100 on architectural judgment) supports vendoring rules rather than naming books in prompts.
Tier 1
11. Rules pack — context-tiered rule books, mapped to the full skill/agent surface

Goal. Add packs/rules/, mirroring the design-pack precedent: the rule books vendored with all three tiers, a manifest recording estimated tokens per tier and the compatibility edges between books, and a coverage map giving every runtime skill and agent its relevant book set and default tier. Full surface, not a sampler: every entry in runtime/skills/ and runtime/agents/ appears in the map — with an explicit books: [] when nothing applies, so absence is a decision, not an omission.

Why. Small local models are the audience this stack serves, and nano/ mini tiers are guidance that actually fits their windows. The compatibility matrix solves a real failure mode — loading two rule sets that fight each other (their matrix marks DDD ↔ PoEAA as conflicting, and the three DDD variants as overlapping — pick one).

Files.

    New: packs/rules/<book>/ (vendored *.md, *.mini.md, *.nano.md + upstream LICENSE)
    New: packs/rules/manifest.json — per book: { id, tiers: {full,mini,nano} → {path, tokensEstimated}, compat: {complementary[], overlapping[], conflicting[]} }
    New: packs/rules/coverage.json — per skill/agent: { id, kind: "skill"|"agent", books: [{ id, defaultTier, why }] }
    New: a drift check (extend scripts/ verify surface) asserting the coverage map lists exactly the current contents of runtime/skills/ + runtime/agents/.
    Edit: README's pack mention if the design pack is currently described as the only pack.

Approach.

    Vendor whatever books the coverage map actually uses — likely most of the 14. Where their matrix marks overlap, pick one (e.g. one DDD variant, likely DDD Distilled, for ideate-product/plan-feature/domain vocabulary work); where it marks conflict (DDD ↔ PoEAA), the coverage map must never assign both to the same skill/agent.
    Seed mapping to draft from (verify against each SKILL.md while executing): Philosophy of Software Design → plan-architecture, plan-design, design-prototype, architect, design-engineer; Refactoring / refactoring-guru → review-code, plan-autoreview, reviewer, rewrite-rust-oneshot; Release It → deploy-ship, ops-canary, ops-deploy-land, setup-observability, diagnose-stack, incident-commander, release-manager; Legacy Code → debug-investigate, rewrite-rust-oneshot, rust-rewrite; DDIA → orchestrate-platform-routing, benchmark-performance, performance-engineer; Clean Code / Code Complete → fast-build, build, test-qa, qa-lead; Pragmatic Programmer → broad default for execution-orchestrator, plan, research. Expect genuine empties (ping, ensemble-consensus, train-model-knowledge-injection, model-trainer, safety-guardrails) — record them as books: [].
    Tier selection is the routing tie-in: pick nano/mini/full from the target lane's context window (inventory already knows the models) and any token budget — same fitting logic as Task 1's repo map, and the two should share a budget convention. defaultTier in the coverage map is the no-budget-info fallback (usually mini; nano for skills that already run on tight lanes). Keep it a recommendation in reasoning output, consistent with the headless contract.
    Respect the compat matrix: never recommend two conflicting books at once; collapse overlapping sets to one.

Acceptance criteria.

    Pack present with licenses; manifest validates; token estimates populated.
    coverage.json covers 100% of runtime/skills/ + runtime/agents/ (empty entries allowed but explicit); drift check fails when a skill/agent is added without a coverage entry.
    No coverage entry pairs conflicting books; overlapping sets collapsed.
    Skills/agents reference their mapped books from their canonical files where it replaces restated content (e.g. Task 10c's deep-module vocabulary).

Effort: L (curation + mapping + drift check). Risk: Low (additive content).
Tier 2
12. Nano tiers for xx-stack's own critical skills

Goal. Apply their full/mini/nano pattern to our own skill layer: author a SKILL.nano.md (~1–2KB) variant for the critical-surface skills (execution-orchestrator, fast-build, review-code, debug-investigate, deploy-ship) so tight-context lanes get real guidance instead of truncation.

Why. This is their best structural idea applied where it matters most for us: a 7B model on a laptop lane cannot hold a 200-line SKILL.md plus the task plus the code. Today the only fallback is dropping the skill entirely.

Approach. Nano = decision rules and gates only (severity ladders, merge gates, iron laws), no examples or output templates. Canonical SKILL.md remains the source of truth; nano is derived and checked for drift the same way mirrors are (extend the existing drift check). Hosts/routers pick the variant by lane context window, same convention as Task 11.

Acceptance criteria. Nano variants exist for the five critical skills, each under ~2KB; drift check covers them; SKILLS.md documents the tier convention.

Effort: M. Risk: Low–Med (drift tooling touch).
Explicitly NOT borrowing

    Redundant variants — vendor what the coverage map uses (likely most books), but only one DDD variant, and skip PoEAA unless a mapping demands it: those carry the repo's only conflict edges and the least routing relevance.
    _rule-workbench/ — their internal authoring tooling.

From jina-ai/node-DeepResearch (reviewed 2026-07-30)

Harvest from node-DeepResearch: an iterative research agent (TypeScript) that loops search → read → reason → reflect until it has a definitive, cited answer or exhausts a token budget. The valuable parts are the loop's control mechanics, not the Jina API integration — all four borrows below work offline against local lanes.
Tier 1
13. research-deep skill — budget-bounded gap-queue research loop

Goal. New skill runtime/skills/research-deep/SKILL.md: answer a hard question by iterating search → read → reason → reflect, maintaining an explicit knowledge-gaps queue (sub-questions the reflect step discovers) until the answer passes a definitive-with-citations bar or the budget runs out.

Why. The existing research/researcher agents map codebases in one pass; nothing in the stack does iterative multi-hop investigation with an explicit record of what is still unknown. The gap queue is the same epistemic move as Task 8's fog-of-war — "unknowns are first-class state" — applied inside a single research task.

Approach.

    Loop mechanics to keep: gaps queue; per-round action set (search, visit, reflect, answer) with toggle-off of an action that just failed or repeated (their anti-loop guard — same problem the supervisor's stall detection solves, handled preemptively); every answer claim carries a citation.
    xx-stack twists: independent gap questions fan out via route_parallel_tasks; the budget comes from the shared token-budget convention (Tasks 1, 11); web search is optional surface — degrade cleanly to repo/docs/local-artifact research when offline (house rule).
    Termination is evaluator-gated: the completion-judge agent applies the definitive-answer bar; on FAIL, reset the working context and retry with the judge's failure reason injected rather than continuing in a polluted context (their retry-reset mechanic).

Acceptance criteria. Skill passes the SKILLS.md contract; documents budget source, gap-queue format, action toggling, judge gate, and offline degradation; SKILLS.md updated.

Effort: M. Risk: Low (prompt-layer; routing tools already exist).
14. Budget-exhausted forced synthesis for the supervisor ("beast mode")

Goal. Give the supervisor completion loop a terminal state between success and failure: when budget, step count, or stall threshold trips, emit a continuation prompt that demands a best-effort final answer from evidence gathered so far, with confidence and remaining gaps declared — instead of only failing over or hanging.

Why. Their "beast mode" is the missing third outcome for supervised long-running work. xx-stack already detects stalls and fails over to another machine; but when every lane is exhausted or the task itself is the bottleneck, the accumulated partial work is currently worth nothing. Forced synthesis converts it into a usable, honestly-labeled result — graceful degradation, which is already a house value.

Files.

    Edit: xx-stack/mcp-server/src/supervisor_completion_tools.ts (or runtime) — new terminal state + a force_synthesis continuation-prompt variant reusing the existing formatter (Task 6 synergy).
    Edit: runtime/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md — document the state.
    Edit/new: matching *.test.ts.

Approach. The forced-synthesis prompt must require: answer from existing evidence only (no new tool calls), explicit confidence, explicit unresolved gaps, and citations to the evidence it does have. Never present a forced synthesis as a normal completion — mark it in the task record.

Acceptance criteria. State reachable from budget/stall triggers; prompt deterministic from fixed inputs; task record distinguishes completed | failed | force_synthesized; runbook updated; tests cover the trigger and the record marking.

Effort: S–M. Risk: Low. Synergy: Task 6 (continuation formatter), Task 13 (same bar), ensemble-consensus's local-only fallback (same philosophy).
Explicitly NOT borrowing

    Jina Reader/Search API integration, server mode, Docker packaging — the loop mechanics matter; the SaaS plumbing doesn't fit local-first.
    Gemini/OpenAI-specific structured-output code — lane models are already qualified via inventory.json reliability fields.

From remix-run/remix (reviewed 2026-07-30)

Reviewed Remix v3: a full-stack web framework rebuilt on web standards (fetch, Web Streams, Web Crypto), 60+ single-purpose packages, zero-dependency doctrine, runtime-over-static-analysis. Verdict: a pass on substance — it solves web-app problems xx-stack doesn't have, and its "model-first development" principle is something xx-stack already practices (agent contracts, machine-readable registries). Captured for the record:
Tier 3
15. Dependency & portability doctrine (optional, docs-only)

Goal. State in CONTRIBUTING.md what is already implicit practice, borrowing Remix's two defensible principles: (a) a dependency budget — new runtime deps in mcp-server need justification, prefer node: built-ins (the repo already uses node:test over jest); (b) prefer web-standard APIs (fetch, Web Streams, Web Crypto) over Node-specific ones where equivalent, so the server stays portable to Bun/Deno without a rewrite.

Acceptance criteria. One short CONTRIBUTING section; no code churn — apply opportunistically when files are touched anyway.

Effort: S. Risk: None.
Explicitly NOT borrowing

    Everything else: routing/SSR/sessions/middleware/data-table are web-app concerns; the composable-packages structure solves a distribution problem a single MCP server doesn't have.

From the jina-ai org sweep (266 repos, reviewed 2026-07-30)

Full-org triage: ~150 archived Jina-framework executors, plus forks, GUIs, and embedding-model research — all passes. Eight repos yielded ten candidate borrows; five were approved for this list.

Standing guardrail for every task below (approved with the caveat "only to the extent that it improves the stack"): each borrow is additive and opt-in. No new required runtime dependencies, no new network calls, nothing on the route_task hot path gets slower, and every feature degrades cleanly when its optional surface (embedding model, reader service, budget hint) is absent. If honoring the guardrail guts a task's value, drop the task rather than bend the guardrail.
Tier 1
16. Submodular context selection under token budgets (from jina-ai/submodular-optimization)

Goal. Port their lazy-greedy submodular selection (balance relevance to the query, coverage of the candidate set, and diversity between picks) as a pure function that fits a candidate list into a token budget.

Why. This is the principled version of "fit the most useful subset into a small context" — xx-stack's central constraint. Two consumers already planned: Task 1's repo map (rank files/symbols under budget) and Task 13's gap-queue fan-out (pick diverse sub-questions, not five rephrasings of one).

Files.

    New: xx-stack/mcp-server/src/context_selection_runtime.ts + *.test.ts
    Edit (when Task 1 lands): repo_map_runtime.ts uses it for budget fitting.

Approach.

    Pure TypeScript, zero deps. Similarity signal is pluggable: default is cheap lexical similarity (token overlap / TF-IDF) so it works with no models loaded; an embedding-based signal via a lane's local embedding model is an optional upgrade, never required.
    Lazy-greedy evaluation (their trick) so large candidate sets stay fast.
    Guardrail: pure function, called only when a caller supplies a budget — existing paths unchanged.

Acceptance criteria. Deterministic for fixed inputs; tests cover budget respected, near-duplicates not co-selected (diversity), lazy-greedy matches naive greedy on small sets; no new deps.

Effort: M. Risk: Low. Synergy: Tasks 1, 13, 20.
17. xx CLI — pipeable command surface over the same runtime (from jina-ai/cli)

Goal. A thin CLI exposing the stack's core operations as Unix-composable commands — xx route "fix the tests", xx platforms, xx diagnose, xx tasks list — for human operators and shell-capable agents.

Why. Their conventions are exactly right for agent consumption: stdout carries data, stderr carries diagnostics, exit codes are meaningful (0 ok / 1 user error / 2 server error), --json on everything, and layered --help sized for token budgets (an agent discovers capabilities progressively instead of swallowing a manual). Today the only surfaces are MCP and raw npm scripts.

Files.

    New: xx-stack/mcp-server/src/cli.ts (+ bin entry in xx-stack/mcp-server/package.json) + *.test.ts

Approach.

    Guardrail: the CLI is a presentation layer only — it imports the same runtime functions the MCP tools call (routing_runtime, platform_runtime, task_runtime). Zero logic forked into the CLI, so it can never drift from tool behavior.
    node:util parseArgs — no argument-parsing dependency.
    Start with read-only + routing commands; execution-policy-gated operations only if they reuse validateExecRequest unchanged.

Acceptance criteria. Commands pipe cleanly (xx platforms --json | jq); exit codes per convention; top-level --help under ~40 lines with per-command help layered beneath; tests cover arg parsing and output shape; no new deps.

Effort: M. Risk: Low.
Tier 2
18. Array-accepting variants of singleton read-only tools (from jina-ai/MCP)

Goal. Let read-only, idempotent tools accept a string or an array and fan out concurrently, returning position-aligned results — e.g. route_task scoring several descriptions in one call.

Why. Their MCP server does this and it measurably cuts round-trips for agents batch-evaluating options; for us it means one tool call to compare routing decisions across N task framings.

Approach. Schema widens to string | string[]; single input keeps today's exact result shape (guardrail: zero breaking change); array input returns an aligned array; bounded internal concurrency; read-only tools only — never mutating or execution-gated ones.

Acceptance criteria. Backward-compatible single-input shape verified by existing tests unchanged; array path tested for alignment and concurrency cap.

Effort: S. Risk: Low.
19. Optional local reader adapter for research (from jina-ai/reader)

Goal. Support a self-hosted reader instance (their Apache-2.0 ghcr.io/jina-ai/reader:oss image — stateless URL → LLM-friendly markdown) as an optional, inventory-declared local service that Task 13's visit action prefers when present.

Why. research-deep needs webpage → clean markdown; the OSS reader does that entirely on your own hardware, which is the local-first way to get it.

Approach.

    Declare it like any other optional surface: an entry on a machine in inventory.json (a services field or equivalent — decide during Task 13), disabled by default like everything a scan finds.
    Guardrail: strictly optional and off by default. research-deep must work without it (plain fetch degradation), the MCP server never talks to it directly (agents do), and no cloud reader endpoint is ever a fallback — absence degrades, it does not escalate.
    Ship a short runbook (compose snippet + inventory entry example), not baked tooling.

Acceptance criteria. Inventory schema accepts the service entry (inventory:check green); research-deep documents the preference order (local reader → plain fetch); runbook exists; nothing else changes when no reader is configured.

Effort: S–M. Risk: Low. Depends on: Task 13.
20. Token-budgeted memory recall + rule-abstraction compaction (from jina-ai/thinkgpt)

Goal. Two upgrades to the agent memory surface (agent_memory_append / agent_memory_get): (a) recall that fits results to a caller-supplied token budget instead of returning everything; (b) a compaction path that turns piles of specific observations into a few general rules.

Why. ThinkGPT's remember(limit_by_tokens) and rule abstraction are the two memory mechanics that matter for small-context lanes. Our memory tools currently have no notion of budget at all.

Approach.

    (a) agent_memory_get gains an optional tokenBudget param; selection of which entries make the cut uses Task 16's submodular function (relevant + diverse beats most-recent-N). Guardrail: param optional, default behavior byte-identical to today.
    (b) The server must not call models (headless contract), so compaction follows the continuation-prompt pattern: a tool emits a distillation prompt plus the candidate entries; the agent produces the abstracted rules and writes them back via agent_memory_append, original entries marked superseded — never silently deleted.

Acceptance criteria. Budget-fitted recall tested (fits budget, stable order, default path unchanged); compaction emits deterministic prompts from fixed entries; superseded entries remain recoverable; existing memory tests untouched and green.

Effort: M. Risk: Low–Med (touches a stateful surface — default-path compatibility is the guardrail).
Explicitly NOT borrowing (reviewed and passed on)

    Server-side tool filtering, the meta-prompt endpoint, query expansion, and semantic-grep-as-lane-capability — candidates offered but not approved in this review round.
    serve, clip-as-service, vectordb, finetuner, embedding-model research (late-chunking, jzip, fingerprints, inversion), all GUIs (correlations, deepsearch-ui, dashboard), and the ~150 archived Jina-framework executors — different product category or dead code.
    jina-on-prem's bundle/deploy tooling — good pattern, but Docker-image provisioning of model runtimes is the machines' concern, not the control plane's; revisit only if lane provisioning ever enters scope.
 Per-tool install docs (the editor.mdc, Codex config) — host adapters are already xx-stack's own concern (adapters/, opencode-orchestration/).

From davidondrej/skills (reviewed 2026-08-02)

Harvest from davidondrej/skills: 43 agent skills across five categories (agent-orchestration, skill-authoring, research-and-web, thinking-and-docs, ops-and-setup). Roughly two-thirds is personal-machine plumbing (macOS ops, the editor/cmux specifics, DeepAPI SaaS integrations, content-capture workflows) — passes. What survives triage is control-loop material: a goal contract for autonomous runs, a battle-tested handoff format, cross-model review discipline, a fleet-wide command denylist, and a batch of small deltas for skills and tasks already on this list.

These are mostly prompt/skill-layer and supervisor-surface tasks. Same ground rules as the mattpocock section; anything touching mcp-server code follows the Tier 1 ground rules at the top of this file.
Tier 1
21. Goal contract for supervised autonomous tasks (upstream: "goal-loop")

Goal. Every task registered for autonomous/supervised execution carries an explicit five-part contract: objective (one sentence), constraints (what must NOT change), validation command (the exact shell command that proves progress), verifiable stop condition, and a docs commitment — plus a mandatory anti-reward-hacking clause ("do not delete, skip, weaken, or narrow tests to make the goal pass").

Why. The supervisor completion loop currently evaluates completion readiness against heuristics; upstream's insight is that the contract should be captured at task registration, making "done" machine-checkable from the start. The validation command is exactly what verify_edit (Task 3, landed) runs; the stop condition is exactly what the completion judge (Task 13) and forced synthesis (Task 14) evaluate against. This turns three planned pieces into one coherent loop.

Files.

    Edit: xx-stack/mcp-server/src/task_runtime.ts / task_tools.ts — optional goalContract field on task registration: { objective, constraints, validationCmd?, stopCondition, docsNote? }.
    Edit: supervisor completion path — when a task has a contract, completion evaluation cites the stop condition and (if validationCmd present) expects a verify_edit result for it.
    Edit: xx-stack/runtime/AUTONOMOUS_TODO_LOOP.md — document the contract as the required shape for loop items; include the anti-reward-hacking clause verbatim.
    Edit/new: matching *.test.ts.

Approach. Contract is optional metadata (guardrail: existing task registration unchanged when absent). Also borrow upstream's meta-prompting rule as prompt guidance: the agent registering a goal should first inspect the repo and surface hidden constraints before writing the contract — cite this in the tool description, same place Task 4's tracer-bullet sizing guidance goes.

Acceptance criteria. Schema round-trip tested; completion evaluation references the stop condition when present; default path byte-identical without a contract; runbook updated.

Effort: M. Risk: Low–Med (touches task store shape). Synergy: Tasks 3 (landed), 13, 14.
22. Failover handoff format for continuation prompts (upstream: "handoff")

Goal. When the supervisor fails a task over to another lane (or a session ends mid-task), the continuation prompt carries a structured handoff: Goal / Current State (DONE, PARTIAL, NOT STARTED — state, not instructions) / Key Decisions and why / Traps & Dead Ends (approaches tried that FAILED) / Relevant Files with line ranges / Open Work with dependencies, ending with a verify-don't-trust preamble ("treat every claim as context to verify against the code, not facts to accept").

Why. This is Task 6's continuation loop seen from the receiving agent's side, and upstream's format is the most concrete one reviewed so far. The two non-obvious rules that earn the borrow: state-not-instructions (the fresh agent decides actions; the handoff gives ground truth) and Traps & Dead Ends (failed approaches are the least recoverable information — exactly what a failover lane needs to not repeat the stalled lane's mistakes). Reference-don't-duplicate matches the mattpocock handoff note already recorded in the synergies above.

Files.

    Edit: xx-stack/mcp-server/src/supervisor_tools.ts or review_tools.ts — extend the continuation-prompt formatter with a handoff variant used by the failover path; deterministic from fixed inputs.
    Edit/new: matching *.test.ts.

Acceptance criteria. Failover continuation prompts follow the section shape; deterministic; secrets never echoed (reference where credentials live, never values); tested.

Effort: S–M. Risk: Low. Synergy: Task 6 (landed), Task 14 (forced synthesis reuses the same formatter).
Tier 2
23. Reviewer-diversity routing (upstream: "fable-review" / "gpt-review")

Goal. A routing option (new route_review tool or a flag on route_task) that selects a review lane whose model differs from the model that authored the work, plus prompt rules for the review itself: neutral and unbiased (don't nudge toward a solution), broad scope (let the reviewer find its own issues), and report returned verbatim — never rewritten by the orchestrating agent.

Why. Upstream ships this as two hardcoded skills (a Fable reviewer, a GPT reviewer); the transferable idea is the diversity constraint — a different model family reviewing catches what the authoring model is systematically blind to. xx-stack can do this properly: the registry knows which lane authored a task, so the router can exclude that model rather than hardcoding a reviewer. Same thesis as route_architect_editor (Task 2, landed), applied to review.

Approach. { description, authoredByModel?, authoredByHost? } → lane whose model differs where the registry allows; collapse gracefully to same-model review with explicit reasoning when only one lane exists (log the shortfall — no silent degradation). The verbatim-report rule goes in review-code and the reviewer agent prompt, tied into Task 10b's two-axis split.

Acceptance criteria. Distinct-model lane preferred when available; single-lane collapse reasoned; cloud stays opt-in; tests cover both paths.

Effort: S–M. Risk: Low. Synergy: Tasks 2 (landed), 10b.
24. Fleet-wide catastrophic-command denylist (upstream: "global-agent-guardrails")

Goal. One versioned denylist of catastrophic shell patterns (rm -rf on / or ~, dd/mkfs, fork bombs, curl|sh, git push --force, repo deletion) as a runtime file, consumed by execution_policy.ts as a deny layer and mirrored to the host adapters (adapters/, opencode-orchestration/) so every lane's agent enforces the same list — with a test suite that must pass after any pattern change.

Why. verify_edit's execution policy is an allowlist for commands the server runs; nothing governs what agents on the lanes run. Upstream's design is right for a heterogeneous fleet: single source of truth, per-host adapters, and the crucial design rule — block only irreversible/catastrophic operations; local-destructive-but-recoverable commands stay allowed, because over-blocking kills agent usefulness. It is a seatbelt against accidents, not a sandbox against a malicious agent — document that limit honestly.

Files.

    New: xx-stack/runtime/dangerous-patterns.txt (one POSIX-ERE per line, # comments) + a test script in xx-stack/scripts/ with block + allow cases.
    Edit: xx-stack/mcp-server/src/execution_policy.ts — deny check ahead of the allowlist; matching *.test.ts.
    Edit: adapter docs/mirrors to reference the shared file (keep canonical-file-wins convention).

Acceptance criteria. Deny layer rejects listed patterns with a structured reason; allow cases (git clean, rm -rf node_modules) pass; pattern-file change without test update fails CI; verify green.

Effort: M. Risk: Low–Med (touches the exec gate — fail-open on pattern-file parse errors so a broken list never bricks the server).
25. Skill-layer and task-spec deltas (batch, one PR)

Each sub-item folds an upstream delta into an existing skill or an already-listed task.

    SKILLS.md authoring contract ← effective-agent-skills (extends Task 10f): the description is a routing contract — what + when + differentiator, and never a workflow summary (an agent that reads a step summary in the description skips loading the body); match instruction strictness to task fragility (loose heuristics → templates → exact scripts); references one level deep, never chained; test every skill against the weakest model it will run on — for this stack that rule is load-bearing, and it becomes the acceptance test for Task 12's nano tiers.
    Task 9 (interrogate-plan) ← next-decision: each question presents the top choices (upstream fixes four; keep 2–4), states a preference, and records the user's answer in the plan doc before moving on.
    reflect-retrospective / plan-autoreview ← decisions: a low-confidence-decision disclosure step — list only the decisions made during the work that the agent is genuinely unsure of, with unconsidered alternatives; explicitly skip decisions already well-settled. The retrospective twin of Task 9's forward-looking interrogation.
    plan-feature / ideate-product ← before-building: a zero-tool instant gate — the moment a build is proposed, surface the 1–3 consequential choices hidden in it (one-off vs. repeated, few lines vs. proper module, biggest thing it could break) before any planning machinery spins up.
    deploy-ship / ops-deploy-land ← prod-push: done means the exact SHA is verified live (CI green + deploy promoted + health endpoint OK for that SHA), never "pushed"; track the SHA through the whole chain; on a superseded push, confirm the newer SHA contains your change (git merge-base --is-ancestor) and track that one instead.
    Task 4 (competitive worktrees) ← git-worktree: the fan-out plan must include a bootstrap checklist per worktree — copy (never symlink) env files, install deps, pin shared-service identity so worktrees don't fight over ports, rebuild gitignored artifacts — and a scripts/setup-worktree.sh convention; a bare worktree is the #1 way a parallel agent fails confusingly.
    Task 8 (plan-decision-map) ← brain-to-docs: resolved decision tickets get a durable record — short numbered ADRs (NNNN-slug.md, Status/Context/Decision/Consequences) — so the decision map's one-line answers link to real rationale.
    Supervisor runbook ← agent-self-scheduling: the heartbeat pattern — one cheap recurring tick gates many per-task checks via last-run timestamps, acts only on what is due, stays silent when nothing is; never put a model on a tight timer.

Effort: M total. Risk: Low.
Explicitly NOT borrowing

    fable-safe-prompt — rewrites prompts to avoid tripping a model provider's safety classifiers; regardless of intent, classifier-evasion tooling is not something this stack should carry.
    All DeepAPI-powered research/web skills (deepapi, deep-research, online-shopping, pi-web-search, research-prompt, youtube-transcript, fireflies-transcript) — SaaS-first; Tasks 13/19 already cover research local-first.
    run-deep-swe — benchmark-scoring lanes via OpenRouter; the reliability harness already owns qualification, and cloud-metered evals conflict with local-first defaults. Revisit only if benchmark-based lane qualification enters scope.
    launch-subagent — the model-pinning rules are personal config; the general delegation principles are already covered by Task 4's tracer-bullet sizing note and route_parallel_tasks guidance.
    goal-loop's /goal feature plumbing (TUI commands, subscription-auth notes, troubleshooting) — only the contract (Task 21) transfers.
 Personal-machine and vendor ops: anti-sleep, nuke-cloud-model, macbook-metrics-setup, cmux, codex-subagent, setup-help, vps-server-management, google-safe-browsing, create-readonly-db-role, pi-custom-model — machine/app concerns outside a headless control plane.
 Author plumbing and content workflows: push-skill-to-github, distribute-skill-to-all-agents (adapters/ already owns distribution), folder-specific-cloud-model, save-idea, teach, level-up, remind, short, read-all-adrs (Task 25's ADR convention covers the useful part).

From block/buzz (reviewed 2026-08-02)

Reviewed Buzz: Block's (same org as goose) self-hostable team workspace where humans and AI agents share rooms on a Nostr relay — every message, patch, review, and workflow step is a signed event in one log; a Tauri desktop app, a Rust relay over Postgres/Redis/MinIO, and an agent surface (buzz-acp harness driving Goose/Codex/a bundled coding-agent over ACP, buzz-agent as a minimal ACP agent, buzz-dev-mcp as a hardened shell/editor MCP server). As a product it is almost entirely out of scope — a GUI workspace plus relay infrastructure for a headless local-first control plane. What survives triage is the harness-boundary engineering, which is unusually disciplined (the VISION_AGENT doctrine — "small enough to read in an afternoon, bounded failure modes, process-group kill on every exit path" — is the same doctrine this stack claims). Four borrows: the underscore-prefixed MCP lifecycle-hook convention, the remote-lifecycle supervision invariants, subprocess hardening for the exec gate, and compare-and-swap memory writes.

Same ground rules as Tier 1 at the top of this file — all four touch mcp-server code.
Tier 1
26. MCP lifecycle hook tools — _Stop and _PostCompact (upstream: docs/MCP_DRIVEN_HOOKS.md + buzz-dev-mcp's todo hook)

Goal. Expose the buzz hook convention from the server side: two underscore-prefixed MCP tools, _Stop (called by a hook-aware harness when the model signals end_turn; non-empty text = objection, agent keeps working; empty = allow stop) and _PostCompact (called after context compaction; returns state to re-inject into the fresh context). Registration gated behind an env flag (e.g. XX_STACK_HOOK_TOOLS=1), off by default.

Why. This is the single mechanism that turns xx-stack's supervision from advisory into enforceable inside any harness that adopts the convention — zero MCP protocol changes, hooks are ordinary tools discovered via tools/list. And the server already owns everything the hooks need: _Stop is a thin adapter over the existing completion-readiness evaluation (open supervised tasks, unmet goal-contract stop conditions from Task 21, memory snapshot drift via getCompletionMemorySyncStatus); _PostCompact re-emits the active goal contract, open task list, worktree resume notice (buildWorktreeResumeNotice), and memory entrypoint pointer — all existing runtime data, no new state. Buzz's reference implementation is exactly this shape: their todo server's _Stop returns "You have open todo items. Keep working." The convention is aligned with the Open Plugin Spec event names and proposed for cross-agent adoption (MCP_HOOK_SERVERS), and buzz-agent is a plausible future lane harness that would consume these hooks with zero extra work.

Files.

    New: xx-stack/mcp-server/src/hook_tools.ts (registerHookTools(server, deps)) + *.test.ts
    Edit: xx-stack/mcp-server/src/index.ts — register only when the flag is set.
    Edit: xx-stack/runtime/AUTONOMOUS_TODO_LOOP.md — note that hook-aware harnesses get stop-gating for free; others keep the prompt-level contract.

Approach.

    Honor the provider-side contract their doc implies: respond fast (callers time out at ~2.5s and treat timeout as no objection — so no filesystem walks or expensive scans in the hook path), deterministic for fixed state, empty string means no objection, output JSON-encoded/plain text (the caller injects it at tool-result trust, not system trust — never emit anything that reads as instructions from the operator).
    _Stop objections must be bounded: the caller enforces a rejection budget (3/prompt in buzz), so each objection should name the concrete unmet condition (task id + stop condition), not restate the whole contract — an objection the agent can act on in one round.
    Off by default because non-hook-aware harnesses would see _Stop/_PostCompact as ordinary callable tools; the underscore prefix plus a "lifecycle hook — not for direct model use" description line is the fallback defense when the flag is on.
    Scoping: hooks take an optional { agentId?, sessionId? } argument object (their spec sends {}) — degrade to fleet-wide open-work summary when absent.

Acceptance criteria.

    Tools absent from tools/list by default; present only with the flag.
    _Stop returns empty when no open supervised work / unmet stop conditions exist; returns a concrete named objection otherwise; deterministic; responds well under the 2.5s convention.
    _PostCompact output re-derives entirely from existing stores (task registry, goal contracts, memory pointers) — no new persistent state.
    Tests cover: empty vs. objection paths, flag gating, determinism.

Effort: M. Risk: Low (additive, gated off by default). Synergy: Tasks 21 (landed — stop conditions are the objection source), 14 (forced synthesis is the escape hatch when objections exhaust the caller's budget), 20 (memory pointers in _PostCompact).
Tier 2
27. Self-enforced task leases + presence-is-status supervision invariants (upstream: docs/remote-agents.md)

Goal. Adopt the three invariants from buzz's remote-lifecycle spec that fit a fleet with no management channel: presence-is-status (silence past a bound is terminal — the supervisor never assumes a kill worked, because it has no kill channel), liveness bounds enforced by the agent itself (an optional lease deadline on task registration that the agent self-enforces), and at-most-one-live-instance (after failover, a returning "dead" lane must detect its lease is revoked and stop rather than duplicate work).

Why. This is xx-stack's actual situation, stated precisely: the MCP server routes and supervises but holds no channel to kill an agent on another machine. Today staleSessionTtlMs handles the supervisor's side (when to give up waiting) but nothing handles the agent's side — a stalled lane that wakes up after failover will happily write back results on top of the failover lane's work. Buzz's answer is structural: the harness enforces its own deadline, and termination-by-decision is final even if the process lingers.

Files.

    Edit: xx-stack/mcp-server/src/task_runtime.ts — optional lease on registration: { expiresAt, revoked?: boolean }; a revoke path flipped by the failover flow.
    Edit: xx-stack/mcp-server/src/supervisor_completion_tools.ts — continuation prompts for leased tasks carry the self-fencing clause: before writing back any result, re-check the lease; if expired or revoked, emit final state and stop — do not write. The failover handoff variant (Task 22, landed) states that the prior lane's claim is revoked.
    Edit: xx-stack/runtime/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md — document the three invariants and the rule that lease expiry + silence is a terminal observation, not a retry trigger.
    Edit/new: matching *.test.ts.

Approach. Lease is optional metadata — registration without one is byte-identical to today (guardrail). Enforcement is prompt-layer (the agent self-fences) plus one server-side check: task-result write-back for a revoked/expired lease returns a structured lease_revoked rejection instead of silently accepting. No clocks-across-machines cleverness — expiresAt is compared against the server's clock at write-back, and the prompt clause tells the agent to stop early, not precisely.

Acceptance criteria. Default path unchanged without a lease; failover revokes the prior lease; write-back after revocation rejected with a structured reason; handoff prompt names the revocation; runbook documents the invariants; tests cover revoked write-back, expiry, and the no-lease default.

Effort: S–M. Risk: Low. Synergy: Tasks 21, 22 (landed), staleSessionTtlMs (the supervisor half already exists).
28. Process-group kill + capture-then-truncate for the exec gate (upstream: buzz-dev-mcp doctrine)

Goal. Harden guardedExecFile / verify_edit to buzz-dev-mcp's standard: "ephemeral processes with process-group kill on every exit path; bounded output." Concretely: (a) spawn detached on POSIX and kill the whole process group on timeout/error/cancel — Node's execFile timeout signals only the direct child, so a test runner that forks workers leaves orphans eating a lane; (b) adopt their capture-then-truncate shape — capture full output up to a hard cap (theirs: 10MB), return the truncated head+tail view (theirs: 50KB/2000 lines with an 8KB tail), and keep the full capture as a scratch artifact in a small ring (theirs: 8) so the agent can grep the complete log without re-running the command.

Why. verify_edit runs whole lint/test suites — precisely the commands that fork children and produce megabytes. Today a timeout strands grandchildren, and truncation (Task 3) discards the only copy of the output the agent might need to diagnose from. Buzz ships both fixes as table stakes for an agent shell; xx-stack's exec gate should meet the same bar.

Files.

    Edit: xx-stack/mcp-server/src/execution_policy.ts — switch guardedExecFile internals to spawn with detached: true (POSIX), kill(-pid) with SIGTERM-then-SIGKILL grace on every exit path; explicit capture cap. Windows: no process groups — degrade to current behavior cleanly.
    Edit: xx-stack/mcp-server/src/verify_edit_tools.ts — return { output (truncated view), fullOutputPath?, truncated: boolean }; artifact ring under the scratch/session dir, oldest evicted.
    Edit: existing execution_policy.test.ts / verify_edit_tools.test.ts.

Approach. Keep the external guardedExecFile signature and the policy gate untouched — this is an internals hardening, not a surface change. Truncated view reuses output_compaction (Task 7, landed) head/tail logic rather than a second truncation implementation. Artifact files live in a per-session scratch dir, never the repo.

Acceptance criteria. A test command that forks a sleeping child leaves no survivors after timeout (POSIX test, skipped on Windows); output beyond the view cap is truncated with a marker and the full capture is readable at fullOutputPath; ring evicts oldest; policy denial behavior unchanged; verify green.

Effort: S–M. Risk: Low–Med (touches the exec gate internals — the policy gate itself must be provably untouched by tests).
29. Compare-and-swap writes for agent memory (upstream: buzz mem patch --base-hash + exit code 5)

Goal. Optional optimistic concurrency on the memory surface's read-modify-write paths: agent_memory_snapshot_sync (direction apply) and agent_memory_mark_superseded accept an optional expectedHash (from a prior get/status call, computed with the existing hashMemoryContent); on mismatch, return a structured write_conflict result with the current hash instead of clobbering. Mirror the convention in the xx CLI (Task 17, landed) as a distinct exit code, borrowing buzz-cli's code-5-is-write-conflict.

Why. Concurrent agents against one project scope are this stack's normal operating mode, and both paths are read-modify-write over a shared file: snapshot apply overwrites live memory wholesale, and mark_superseded rewrites entries in place — either can silently destroy an append that landed in between. Buzz's NIP-AE mem patch solves exactly this with a base-hash precondition; the hash function already exists here, so the borrow is a precondition parameter and a structured conflict, nothing more.

Approach. Parameter optional; omitted = today's behavior byte-identical (guardrail). Conflict response includes { currentHash, hint: "re-read and retry" } — the caller merges, the server never does. No locking, no new state.

Acceptance criteria. Mismatch rejects without writing; match writes; omitted param path covered by existing tests unchanged; CLI surfaces the conflict as exit code 5 with JSON on stderr; tests cover all three.

Effort: S. Risk: Low. Synergy: Tasks 17, 20 (landed — same surface).
Explicitly NOT borrowing

    The entire Nostr substrate — relay, signed events, keypair identity, owner attestation (NIP-OA), agent auth (NIP-AA), encrypted engram memory sync (NIP-AE), hash-chain audit log, Postgres/Redis/MinIO — a different product category: xx-stack's source of truth is inventory.json and local files, not a multi-party event log. Adopting any slice would drag in key management for zero routing value.
    Desktop app (Tauri), mobile clients, channels/DMs/threads, canvases, media with frame comments, voice huddles, forum voting — GUI workspace concerns, the exact category the guiding constraint excludes.
    buzz-workflow (YAML triggers, reaction-as-approval gates) — the server does not become a workflow engine; runbooks + skills + the supervisor loop already own orchestration, and approval is a human/agent concern, not a control-plane feature.
    buzz-agent and buzz-dev-mcp as binaries — an ACP agent loop and a shell/editor MCP server are lane-harness concerns; lanes bring their own harness. Only the doctrine (Task 28) and the hook convention (Task 26) transfer.
    The remote-agent provider protocol, buzz-backend-kubernetes, and the sprig image — lane provisioning is the machines' concern, not the control plane's (same call as jina-on-prem, above). The lifecycle invariants transfer (Task 27); the deployment plumbing does not.
    buzz-persona pack/merge/resolve — runtime/agents/ + packs/ already own persona and config layering.
    buzz-cli wholesale — Task 17's CLI already ships the same JSON-in/JSON-out, meaningful-exit-codes conventions; only the write-conflict exit code transfers (folded into Task 29).
 Reply guard, multi-convention skill-dir discovery (.agents/.goose/.), context self-handoff mechanics — harness-side loop concerns; the useful fragment (re-inject state after compaction) is Task 26's _PostCompact.
    Conformance suite and formal/ specs — protocol-suite rigor at a scale a single MCP server does not need.
