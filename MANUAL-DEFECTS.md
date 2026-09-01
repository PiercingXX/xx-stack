# xx-stack defect register

This is MANUAL.md §11, split out so the operating manual stays usable. Every
entry was confirmed with file:line evidence or command output. All 59 original
audit entries are **FIXED** unless a later note says otherwise. Open judgment
calls remain in §11.1.

Status of this document: current as of 2026-09-01. The operating manual is
`MANUAL.md`.

---

## 11. Defect register

Findings from the 2026-08-02 audit. Every entry was confirmed with file:line
evidence or command output. Severity: **CRITICAL** (data loss or security),
**BUG**, **RISK**, **DEAD**, **STALE**, **NIT**.

**All 59 entries below are FIXED**, in commits `7928da7` and `c29cb37`. The
descriptions are kept in the past tense as a record of what went wrong and why
— several describe failure modes worth recognizing again. Anything still open
is in §11.1.

Two things are worth carrying forward from how these were found:

- **Passing tests proved very little.** 257 tests were green while the store
  could be truncated by a read error, a restricted agent could silently become
  unrestricted, and the exec denylist could fail open. Every one of these
  needed a test written specifically to fail first.
- **Three gates were green because they checked almost nothing** —
  `agents:check` covered 8 of 21 agents, `search_tools`' catalog was 11 tools
  stale, and a supervisor self-test asserted `count >= 0`. A green gate is a
  claim; check what it actually iterates over.

### MCP server

| ID | Severity | Finding |
|---|---|---|
| MCP-1 | CRITICAL | `readSupervisorStore`/`readTaskStore` end in a bare `catch` returning an **empty store**. That covers parse errors and EACCES, not just ENOENT. Every handler is read→mutate→write-whole-document, so one transient bad read makes the next write **truncate all sessions/tasks**. Worst case: `supervisor_status`, a pure inspection tool, writes unconditionally. |
| MCP-2 | CRITICAL | `parseAgentProfile` always emits every key including `undefined` values; `mergeAgentProfiles` spreads them over the base. Any agent merely *mentioned* in user config loses its repo `model`/`mode` and has `toolPolicy.deny` overwritten with `[]`. An empty allow-list means allow-all — **a restricted agent silently becomes unrestricted.** |
| MCP-3 | CRITICAL | `execution_policy.ts` loads the denylist via `new URL(...).pathname`, which is percent-encoded. An install path containing a space or `#` makes `readFileSync` throw and the loader **fail open to an empty denylist**. Also broken on Windows. |
| MCP-4 | BUG | The task **lease fence is enforced on 1 of 3 write paths**. `task_suspend` and `task_resume` mutate the same task with no lease check, so the at-most-one-live-instance invariant does not hold. Leases are also not revoked on `supervisor_abort_session` or `supervisor_complete_session`. |
| MCP-5 | BUG | `compactOutput` overruns its own cap (reserves 24 chars for a 28+ char marker) and, for any cap ≲62, returns the **full uncapped string with an empty `dropped` list** — the inverse of its documented contract. |
| MCP-6 | BUG | `lookupModelCost` does exact-key lookup against a **glob-keyed** rate table (`ollama/*`, `sglang/*`), so every local-lane entry is unreachable and cost reports `unknown-model` instead of 0. |
| MCP-7 | BUG | Path traversal: `log_worker.ts` joins an unsanitized `sessionId` into a `.jsonl` path. A session id of `../../../tmp/x` writes outside the log dir. Same class in `sanitizeNameForPath`, which permits `.`. |
| MCP-8 | BUG | `review_to_continuation` passes a hardcoded `null` memory-sync status alongside a truthy flag, so it **always reports "no memory drift"**; it also renders every note twice, and runs `git diff` with no `cwd` (wrong repo) embedding the raw diff unredacted. |
| MCP-9 | BUG | `_Stop` writes to the filesystem and runs an unbounded O(n·m) LCS on an append-only file, against its own "two file reads, no walks" contract and a ~2.5s budget. |
| MCP-10 | BUG | `agent_memory_append` is the one memory write path with **no concurrency control** — read-then-write, so concurrent appends lose data. Every other path grew a CAS precondition. |
| MCP-11 | BUG | `progressObserved` sets status `running`, then a stale `cooldownUntil` overrides it to `cooldown` in the same tick. After any fallback, **real progress reports as cooldown** for the whole backoff window. |
| MCP-12 | BUG | External lifecycle hooks are awaited **inside** the non-reentrant task-store mutex. Any hook calling back into task tools deadlocks permanently. |
| MCP-13 | BUG | `search_tools`' `TOOL_CATALOG` is hardcoded and **11 tools behind registration** — the tool-discovery surface is a stale second registry. |
| MCP-14 | BUG | `repo_map_runtime.ts` interpolates a repo-controlled filename into an `execSync` shell string. A tracked file named with `"` or `` $( ) `` executes arbitrary shell. |
| MCP-15 | RISK | `verify_edit`'s allowlist includes `node` and `npx`, which grant arbitrary execution and route around the denylist. |
| MCP-16 | RISK | `record_telemetry` returns `"recorded"` without awaiting the write, and the writer discards errors. |
| MCP-DUP-1 | DEAD | Two identical `estimateTokens` — `repo_map_runtime.ts` defines its own while already importing the module that exports it. |
| MCP-DUP-2 | DEAD | Repo-root resolution copy-pasted 4× with divergent behavior, while the intended shared helper `repoRegistryPath` sits **unreferenced**. |
| MCP-DUP-3 | DEAD | `cli.ts` states it forks zero logic, then copy-pastes `filterTasks`, `summarizePlatforms`, and `diagnoseHosts` from the tool handlers. Only the CLI copies are tested. |
| MCP-DEAD-1 | DEAD | `invalidateRegistryCache`, `repoRegistryPath`, `ScopedWork.fleetWide` — zero references repo-wide. |
| MCP-DEAD-2 | DEAD | `supervisor_run_self_test` asserts `sessionCount >= 0` — cannot fail, including when the store is unreadable. |
| MCP-TEST-1 | BUG | `review_tools.test.ts` **reimplements the logic inline and asserts against its own reimplementation**; it never imports `review_tools.ts`. The tool has zero real coverage and three confirmed bugs. |
| MCP-TEST-2 | RISK | 28 of 46 runtime modules are never imported by any test, including `supervisor_session_tools.ts` (635 lines) and `config_runtime.ts`. |

### Hermes

| ID | Severity | Finding |
|---|---|---|
| HERMES-1 | CRITICAL | The **shipped allowlist is bypassable to arbitrary execution**: `find -exec /bin/sh` (the `+` terminator is not in the metacharacter guard), `rg --pre`, and `cat ~/.hermes/config.yaml` — where the docs say premium credentials live. Double-gated behind two off-by-default flags, but the allowlist is documented as the safety boundary. |
| HERMES-2 | CRITICAL | `subagents_allow_cloud_default` code default is `True` while config says `false`. If the key is dropped during regeneration, cloud delegation silently enables for every subagent. **A cloud gate must fail closed.** |
| HERMES-3 | BUG | `hmac.compare_digest` on a non-ASCII bearer token raises `TypeError` **pre-auth**, crashing the handler thread for any unauthenticated caller. |
| HERMES-4 | BUG | `HTTPError` body is read but never closed — an fd leak on every failed upstream call in a long-running proxy. |
| HERMES-5 | BUG | The proxy does not drain the request body on 401/404 paths; with HTTP/1.1 keep-alive the next pipelined request is parsed from the undrained body. |
| HERMES-6 | BUG | Request body read is unbounded and untimed — a large `Content-Length` parks a thread indefinitely. |
| HERMES-7 | BUG | `resolve_api_key` runs `subprocess.run(..., shell=True)` with **no timeout**; a hanging credential helper blocks the calling thread forever. |
| HERMES-8 | DEAD | The strict tool-call gate requires `task_profile == "default"`, which **no shipped preset uses**. The entire strict branch is dead in production while two docs promise it is on by default. |
| HERMES-9 | DEAD | `proxy.log_prompts` is plumbed through three layers and **never read**. |
| HERMES-10 | DEAD | Five `policy.*` keys are generated from inventory and read by nothing — including cloud-gate-sounding names, a misleading control surface. |
| HERMES-11 | RISK | Generated `primary_lane_order` is raw object order, not priority order; adding a machine in the wrong position silently stops honoring priority. |
| HERMES-12 | BUG | Proxy total-failure requests write no telemetry at all. |
| HERMES-TEST-1 | BUG | The safety tests use a hand-picked 4-command allowlist, **not the shipped one** — which is exactly why HERMES-1 went unnoticed. |
| HERMES-TEST-2 | BUG | 19 temp directories leak into `/tmp` per suite run. |

### Build, CI, tooling

| ID | Severity | Finding |
|---|---|---|
| BUILD-1 | BUG | `sync-vscode-agents.mjs` hardcodes 8 agent specs; the repo has 21. `agents:check` reports green having verified 8 and **silently skipped 13**. `check-rules-coverage.mjs` shows the right pattern: derive the expected set by reading the directory. |
| BUILD-2 | BUG | `design:html-gate` **fails 20/67 files** and is wired into neither `verify` nor CI, while CONTRIBUTING advertises it as a gate. |
| BUILD-3 | RISK | The 25 `.mjs`/`.js` scripts are never linted (`lint` is `--ext .ts` only). |
| BUILD-4 | RISK | `.skippy/` — a live agent workspace holding session traces and **verbatim user prompt history** — is not gitignored. One `git add -A` publishes it. |
| BUILD-5 | DEAD | `harness-watch.mjs` has zero references, while `harness:watch` reimplements it as an inferior shell loop that spins forever on failure. |
| BUILD-6 | RISK | Empty-directory vacuous passes in `check-stack-source-drift.mjs` and `check-rules-coverage.mjs`: an empty set compares equal and reports PASS. |
| BUILD-7 | RISK | Unguarded `JSON.parse` and deep property access in `toggle-lane.mjs` turn a malformed inventory into an uncaught stack trace. |

### Content and documentation

| ID | Severity | Finding |
|---|---|---|
| CONTENT-1 | BUG | Four OpenCode agents (`build`, `execution-orchestrator`, `fast-build`, `plan`) **begin without the opening `---`**, so their frontmatter does not parse. These are the four primary-mode agents. |
| CONTENT-2 | BUG | The OpenCode `execution-orchestrator` mirror is missing ~120 lines of behavioral guardrails present in canonical: the entire Multi-Agent Dispatch section (concurrency and spawn-depth caps, result merge contract), Task Phase Model, Context Compression, Autonomous Outer Loop Mode. |
| CONTENT-3 | BUG | The OpenCode supervisor runbook is missing ~90 lines documenting **shipped code**: goal contract gate, terminal states, forced synthesis, failover handoff, lease invariants, heartbeat pattern. |
| CONTENT-4 | BUG | Documents reference tiers that do not exist (`primary`, `reasoning`, `overflow`, `compatibility`). `parallel-execution-orchestrator` instructs an agent to select by ids that can never match. |
| CONTENT-5 | BUG | A path cluster pointing at directories that do not and will not exist: `.xx-stack/skills/`, `.xx-stack/platforms.json`, `.xx-stack/config.json`, and `~/.config/xx-stack/...` — the code reads `~/.config/opencode/...`. |
| CONTENT-6 | BUG | `runtime/model-recommendations.json` matches on providers (`self-hosted-api`, `local-catalog-api`, `compatibility-api`) that exist in **no** shipped registry — every profile is unreachable. The OpenCode mirror, which matches on VRAM thresholds, is the correct side. |
| CONTENT-7 | BUG | `design-system-pick.prompt.md` is an adapter surface for a skill that does not exist. |
| CONTENT-8 | BUG | Registry orphans: `parallel-execution-orchestrator` is unregistered in canonical `config.json`; `design-engineer` is unregistered in the OpenCode config — each registered on the other side. |
| CONTENT-9 | STALE | Content drift in 4 skill mirrors (`write-docs` 139 lines, `audit-security` 66, `setup-observability` 32, `train-model-knowledge-injection` 8) and 5 agent mirrors — canonical received generalization edits the mirrors never got. Canonical is correct in every case. |
| CONTENT-10 | STALE | `design-prototype` exists on disk with a full SKILL.md and a coverage entry but appears in **no** index — not `SKILLS.md`, not the OpenCode twin, not `config.json`. |
| CONTENT-11 | STALE | `xx-stack/vscode/` contains exactly one file, a pre-rename fossil superseded by the `adapters/` copy, unknown to the layout verifier. |
| CONTENT-12 | STALE | Count drift: "138 design systems" (actual 137) across 12 files; "33 tools" (actual 47) in 2; and a test count in CONTRIBUTING that was stale by 4x. Hardcoded counts in prose rot silently — §1 now carries the commands to regenerate them instead. |
| CONTENT-13 | STALE | `CHANGELOG.md` stops at 1.63.0 with no Unreleased section, 74 commits behind. |
| DOC-5 | NIT | README says the second folder "symlinks into" the first; `opencode/agents` and `opencode/skills` are full copies. |
| HERMES-DOC-1 | BUG | Two items marked "shipped" in the hermes TODO reconciliation were only partially true: `attempts` never reached `routing.jsonl` (the event had no such field), and `proxy.log_prompts` credited a control that was never read. Both now true: the field is written, and the dead key is gone. |

### 11.1 Still open

Each of these needs a human judgment call rather than a fix. None is a
data-loss or security risk — but note that this section previously claimed
none was a **correctness** risk either, and that was wrong: three vendored
design systems shipped body text at 1.06:1 contrast against their own declared
surface. That is now caught by a gate and fixed, and the claim is corrected
here rather than quietly dropped.

| Item | Severity | Why it is still open |
|---|---|---|
| The design pack pins no upstream commit for `design-systems/` and `workflow-skills/`. | OPEN | The **window** is now recorded (`9ee2c19..483e00d`, 57 commits sharing one tree) and `craft/` pins `dceac12`, so this is narrower than it was. What remains: nothing in the pack distinguishes commits *inside* that window, so a single sha would be invention. Resolving it means re-vendoring at a pinned sha — which must not silently revert the 12 design-system and 10 workflow-skill files now recorded as our edits. |
| Apache-2.0 §4(b) notice placement for modified files. | OPEN | 12 design systems and 10 workflow-skill files are recorded centrally in `manifest.json` rather than annotated in place, which preserves byte-comparability against upstream. A reviewer may prefer per-file headers; that is a licensing-posture call, not a defect. |
| Trademark posture for ~100 brand names in `design-systems/`. | OPEN | Nominative descriptive use is normally fine and the risk is inherited from upstream, but no explicit decision is recorded in this repo. |
| 14 accent-on-surface pairs sit below 3:1. | OPEN | `design:systems-lint` reports these and deliberately does not fail: a brand primary used as a CTA fill is non-text, and these are upstream design choices. Treating them as defects means editing 14 brand primaries — a design decision, not a repair. |
| Three coverage-map entries are weak fits. | OPEN | Rewriting the 62 rule-book instructions surfaced them: `ideate-product` → DDD Distilled (only the Core/Supporting/Generic subdomain split applies; the other nine-tenths of the book has no decision point in a founder interview), `plan-design` → APoSD (applies to one step of eight), and `research`/`researcher` → Pragmatic Programmer (whose own coverage `why` admits it is a "broad default", and the agent never writes code). Each has a real hook and none was forced — but a different book, or an explicit `books: []`, would be defensible. **Nothing validates the map for fit**: `rules:check` proves every entry exists, not that it is the right one. |
| A per-brand CSS token contract for the design systems was evaluated and declined. | It would make "does this artifact honour its design system" mechanically checkable, which is genuinely attractive. Declined for now on two grounds: the source project itself argues against treating token values as rendering instructions (its position is recorded in `packs/design/manifest.json` as a dissent, marked OPEN and explicitly not blocking a future change of mind), and taking the full per-brand package would multiply the pack roughly thirtyfold. The positions are compatible while a token file is a *verification surface*, and incompatible the moment an agent is pointed at it instead of the prose. |
| A "stop and ask the human" action-risk taxonomy was evaluated and declined. | Classifying an action by its real effect — exfiltration, shared-state mutation, deferred effects like webhooks and schedules — is a good idea and better articulated elsewhere than here. It does not fit: this exec gate is deliberately binary, allowed or denied, and "ask the human" presumes an interactive consent surface a headless control plane does not own. The caller executes; we recommend. Revisit only if a caller-side consent contract is ever introduced. |
| The `full` tier of all 11 rule books is unused. | NIT — **do not "fix"** | Every coverage entry selects `mini` or `nano`. ~74 KB reachable only when a host overrides `defaultTier`, which `coverage.json` documents as intended. Recorded so nobody deletes content that is deliberately on standby. |

### 11.2 Closed since the audit

| Item | How it was resolved |
|---|---|
| **Three vendored design systems shipped illegible body text.** `bold` declared `Text #111827` on `Surface #111111` — **1.06:1** — while its own prose said *"Keep body copy on Text (#111827) for legibility"*. `pacman` 1.18:1, `energetic` 2.11:1. AA needs 4.5:1. | A new `design:systems-lint` gate found a **fourth** (`mono`, 3.82:1) on its first run, which a careful manual pass had missed. Each fixed with a value this same upstream generator already emits for that surface polarity, so the repair is the batch's own output rather than an invented colour. All four recorded as local edits; §4(b) set 8 → 12. Upstream still has the bug — pointer retained. |
| **The 137 design systems were entirely ungated.** `design:golden` covers 5 eval tasks, `design:html-gate` covers 67 generated artifacts; neither read the pack's largest and most-consumed surface. | `design:systems-lint` parses their prose into a token map without modifying a byte (mutating `fs` entry points are stubbed before the first open) and checks contrast on **declared** pairs only. Role-bucketed cross-producing was measured at 52% false positives and is recorded in the script as rejected, so it is not re-derived as an obvious idea. |
| `packs/design/craft/` and `licenses/` were unknown to the layout verifier. | 30 → 52 checks, per-file rather than per-directory — the 11 rulebook slugs *are* the `od.craft.requires` vocabulary, so a rename silently breaks every skill bound to it. |
| `drift:check` printed an `OPEN` waiver every run for the `design-system-pick` brand list. | Resolved as a rotted list, with git evidence: `d458c02` removed `claude` from both copies symmetrically but *added* two entries to only one. Five slugs were broken; **all 121 brand ids now resolve**, where five brands were previously unselectable by any agent — including the one the waiver was arguing about, which was itself a wrong slug. |
| The pack shipped a rule saying "never animate `width`" alongside six example decks animating `width`. | `animate-layout-property` promoted P1 → P0 and all six converted to `transform: scaleX()`. Example decks are what agents copy from, so an advisory would have outlived the rule. Zero hits remain. |
| The rules pack had no working delivery mechanism. | 11 vendored books, a 49-entry coverage map and a CI gate validating it — reachable only through a bare noun phrase on the last line of each file. All 62 pointers rewritten as imperative instructions sited at the decision the book would change. Documented in §7, because "it has one now" is less useful to the next reader than "it did not, and the failure was invisible". |
| 118 palette tokens were silently dropped after the re-vendor, and mean capture fell 96.0% → 91.8% while every regression floor passed. | Markdown tables in a colour section were refused because in the original 137-file corpus exactly one existed and it was an alpha ramp — correct on the evidence then, inverted by 9 of 14 incoming brands. Table extraction added with a header-cell discriminator matched exactly (`kami`'s ramp would otherwise register a token named `0.08`, and its "Solid hex" header defeats a substring test). A capture **rate** floor was added: count floors cannot detect a capture regression while the corpus grows. |
| **Forced synthesis ran on evidence the agent authored, then told the model to cite only that evidence.** An agent that invented its evidence list could cite it perfectly — on the salvage path, reached exactly when budget is exhausted and the incentive to inflate peaks. | The prompt now opens with facts read from persisted state (continuation count, elapsed, recorded events, contract validation outcomes) and labels caller-supplied evidence unverified, with the rule that a recorded fact beats a claim. No clock read and sorted checks, so the render is byte-identical for identical state. Scoped precisely: the *strict* completion path was already grounded — it demands a real `verify_edit` result for the contract's command. |
| `_Stop` did not carry the null-result clause — the one surface that applies the pressure the clause exists to relieve. | A prospecting task whose honest answer is "nothing worth changing" has an unmet stop condition by construction, so `_Stop` objected until the rejection budget was spent and the cheapest escape was to invent a diff. The clause now renders there, nested under an existing bullet so it spends none of that budget. |
| `build_repo_map` read every file with no size or binary guard, and its `.gitignore` negation handling silently re-excluded files git deliberately re-included. | A 20 MB binary was ranked, selected and returned **as code context**; a 1 GB file would have killed the server. 2 MiB cap plus a NUL sniff over git's own 8000-byte prefix, so the verdict matches `git diff` rather than inventing a second definition. The redundant second ignore pass is gone on the git path. A third latent bug surfaced: a bare directory name excluded nothing, because the matcher compared `vendor` against `lib.ts`. |
| That file had two prior silent-drop defects whose causes were fixed while their *reporting* was not — so the next cause recurred invisibly, twice. | `build_repo_map` now returns its negative space: considered, ignored, unreadable, oversized, binary, empty, dropped-for-budget, dropped-for-scale, truncated. The reporting is the actual fix; the cause fix alone had already failed twice. |
| `build_repo_map` missed its own recorded performance criterion by 65%. | One `git log` spawn **per file** — 733 spawns, 3.1s against a recorded 2s bound. One `git log -z --name-only` walk replaces them: 0.53s, verified to reproduce per-file timestamps exactly on 75/75 sampled files. Candidate selection capped at 1000, measured at 3.2× the adversarial packing bound and where the O(K²) stage still fits the time budget. |
| `contextWindow` was parsed into every model descriptor and read by nothing, while the repo map hardcoded an 8000-token budget. | The budget now derives from the routed model's real window at 25% of nameplate — which is what 8000 already implied for a 32k window, so behavior is preserved for the model class that number was written for and scales for the rest. Explicit budgets still win; unknown windows still yield exactly 8000. |
| `compactOutput` inflated its output and reported the inflation as a saving. | 20 bytes became 80; a 4-byte input claimed 22 bytes truncated and severed its own marker mid-word. It survived because the tests counted **lines** while output quadrupled in **bytes** — the third instance of a gate measuring the wrong unit. Collapse is now per-run and byte-measured, with a whole-function never-worse postcondition proven across a 3,936-case sweep. |
| `verify_edit` output bypassed the repo's own redaction policy and landed in a world-readable tmpdir. | The highest-variance untrusted text in the system — arbitrary lint and test stdout, exactly where a failing DB test prints its DSN — reached the model raw. The travelling view is now redacted; the local capture stays greppable at `0600`. Wiring that in enlarged an existing over-redaction flaw, so the auth-scheme pattern now requires a credential shape: a tsc error reading `token expected here` is no longer mangled. |
| `redactSecrets` left credentials embedded in URL userinfo. | `postgres://admin:hunter2@db.internal/prod` passed every pass: value patterns enumerate vendor formats, the key-name pass wants a secret-ish noun, the auth-scheme pass wants a literal `Bearer`. The structural dotenv pass caught it only when a caller named a dotenv path — and the production callers pass none. Now always-on, greedy to the last `@` so a password containing `@` is covered, username kept so a handoff can still say which user on which host. |
| `hermes bench` could be won by a broken model. | It never inspected the reply, so a repetition loop emitted tokens fast and scored **4.3× faster** than a healthy answer — and the qualification matrix names this bench as its input with per-lane throughput thresholds. Now gated on `finish_reason` and a repeated-trigram ratio, with estimates never sharing a field with measurements and every exclusion visible. |
| `atomicWriteTextFile` never fsynced, as sole writer for both durable stores. | Atomic rename gives visibility, not durability. Now fsyncs the file before rename with a best-effort directory sync. Cost recorded honestly: 0.17ms → 4.09ms per write on ext4, unchanged on tmpfs — noted because benchmarking it in `/tmp` concludes it is free. |
| Appends could concatenate into an unparseable record. | Three sites appended without checking the file ended in a newline, so a torn write merged with the next record. The healing newline now rides in the same write, which is the point — a separate append reopens the window it closes. |
| The entire 47-tool surface used a registration API deprecated in the SDK already depended on, and our own docs named it the pattern to copy. | Migrated to `registerTool`. Every tool now declares read-only, destructive, idempotent and open-world hints — previously **zero** did, so a client could not distinguish `list_platforms` from `verify_edit`, which undercut the tool-policy story. Declared once per tool beside the catalog entry with a fail-closed default, and a drift test that fails on an undeclared tool, an over-declared one, uniform hints, or a stray deprecated call site. |
| The em-dash token form was unextracted. | Pattern `C` added; capture 95.7% → 96.0%, and the regression floors were tightened from loose values to the exact baseline — a loose floor cannot tell a broken pattern from edited content. **Corrects an error in this document**: the gap was recorded as affecting `xiaohongshu` *and* `miro`. It was xiaohongshu-only. Miro's six misses are the dual-value form (`Light #ffc6c6 / Dark #600000`), which is a correct refusal and stays refused — which is also why files-at-100% did not move. |
| Routing ranked lanes on nameplate hardware only, while `monitor-memory.ts` already computed live residency and memory pressure and threw them away. | Task 38. The arithmetic is extracted to a pure `host_memory_runtime.ts` shared by the CLI and the router, retiring a fork before it existed. The probe rides the existing health fan-out (no new network call) and `hostCapacityScore` stays nameplate-only. Bounded at 4 points against a smallest cross-tier gap of 9.1, so it settles the one case nameplate scoring cannot — two runtimes on the same box, 0.25 apart — and provably nothing else. Scope is honest: `supportsResidentModelInspection` is true for Ollama only, so this improves one lane family. |
| Deck skills had no rule keeping build instructions out of rendered content. | Task 41. A production control is honored by *what you build*, never by *what you write*: "make slide 4 a bar chart" picks a layout and is spent, rather than shipping as the headline. The `deck` profile turned out to have four skills, not the two expected — `weekly-update` does not read like a deck but has the highest chart-instruction-leak risk of them. |
| The manifest overstated the refero attribution and disagreed with itself on the authored-here count. | Refero scoped to the verified 3 of 11 rulebooks (~10% of bytes, corroborated by upstream timing); authored-here count reconciled 93 → 79 with the discrepancy explained. |



Four items moved out of §11.1. Each has a test or gate that fails without the fix.

| Item | How it was resolved |
|---|---|
| `design-system-pick` prompt: the OpenCode copy listed `ollama` and `opencode` design systems the xx-stack copy omitted — the register's one `OPEN` drift waiver. | Adjudicated as a rotted list, not de-branding, on git evidence. `d458c02` ("dedupe, de-brand, fix CI") touched both copies in one commit: it removed `claude` from **both** — that was the de-branding, and no `claude/` directory exists to select anyway — and added `ollama`/`opencode` to the OpenCode copy **only**. The canonical copy was simply missed. De-branding also could not explain it, because both components resolve `packs/design` to the same directory (`opencode-orchestration/packs/design` is a symlink), so there is no per-component brand subset. A brand in the pack but absent from the list is unselectable, which makes this a functional gap. Both copies now list `ollama` and `opencode-ai`. The same pass found the enumerated ids had never been validated against the tree: `mistral`, `runway`, `linear`, `the-verge`, and the newly-added `opencode` resolved to nothing — corrected to `mistral-ai`, `runwayml`, `linear-app`, `theverge`, `opencode-ai`. Every id in both copies now resolves to a directory. The dead `KNOWN_DELTAS` entry was deleted rather than left to rot, and `drift:check` prints no `OPEN` line. |
| `log_worker.logEvent` swallowed every write error. | The policy question is answered: **telemetry never fails a caller's operation** — it is an observability sink, and a metrics failure taking down routing would be absurd. Silence is the part that was wrong. `logEvent` still never throws, but it now returns a `LogEventResult`, counts failures in `telemetryHealth()`, and announces each distinct failure once on stderr (stdout is the MCP channel). `record_telemetry` reports `durability: "failed"` with the reason instead of always claiming `best-effort`, and surfaces the process-lifetime counter — the only trace the 24 fire-and-forget `void logEvent(...)` call sites ever leave. The `dirEnsured` latch is cleared on failure, so a deleted log directory is re-created instead of killing telemetry for the life of the process. |
| `hardwareCache` cached partial probe results permanently. | Per-probe memoization. A probe that succeeds never runs again; a probe that fails is retried on the next call until it has failed 3 times, then treated as genuinely absent. A fully-successful call is still cached wholesale, so the common path is unchanged at three `execFile`s once. An unavailable probe still leaves its field unset rather than throwing. |
| `search_tools` categories were a stretch for some tools. | The enum was widened with `context` and `verification`, and `build_repo_map` / `verify_edit` were re-filed out of `observability`. It is a schema change, but an additive one on a *discovery* surface: the five original values still validate and the filter is optional. `TOOL_CATALOG` stays curated — see the comment above it for the measured reasons derivation from the registrations was rejected. |

---
