# xx-stack Manual

A complete reference for operating, extending, and maintaining this repository.

**Audience.** Someone who has to change this codebase or run it in anger. The
root `README.md` explains *why* the project exists and gets you to a first
routing decision in two minutes; this document explains *how everything works*
and *where the bodies are buried*.

**Status of this document.** Current as of 2026-08-03. §11 is a defect
register: every confirmed problem this codebase has had, what it actually
broke, and its status. Everything there is **fixed** unless its row says
otherwise; the handful of genuinely open items — all judgment calls rather
than defects — are collected in §11.1.

The register is kept rather than pruned on purpose. Several entries record a
gate that was green while proving nothing, or a fix whose cause was addressed
while its *reporting* was not, so the same class of bug recurred invisibly.
Those are worth more as a record of how this codebase fails than as history.

One correction is carried in place rather than quietly dropped: §11.1 used to
assert that nothing in it was a correctness risk. That was wrong — three
vendored design systems were shipping body text at 1.06:1 contrast against
their own declared surface, and no gate read those files at all. Both are
fixed. "We checked and found nothing" and "we never looked" are different
statements, and this document should not blur them.

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [Repository topology](#2-repository-topology)
3. [The single source of truth: inventory.json](#3-the-single-source-of-truth-inventoryjson)
4. [The MCP server](#4-the-mcp-server)
5. [Tool reference](#5-tool-reference)
6. [The runtime layer: skills and agents](#6-the-runtime-layer-skills-and-agents)
7. [Content packs](#7-content-packs)
8. [The Hermes subsystem](#8-the-hermes-subsystem)
9. [Gates, CI, and what they actually prove](#9-gates-ci-and-what-they-actually-prove)
10. [Configuration reference](#10-configuration-reference)
11. [Defect register](#11-defect-register)
12. [Maintenance conventions](#12-maintenance-conventions)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What this is

xx-stack is a **headless, local-first MCP control plane**. It answers the
question *"which of my machines should run this piece of work, and with which
model?"* and then supervises the work until it finishes, fails, or has to be
handed to a different machine.

Three properties define the whole design, and every change should preserve them:

- **Headless.** The server routes, supervises, and qualifies. It never becomes
  a desktop app, an editing REPL, or a workflow engine. It recommends; the
  calling agent executes.
- **Local-first.** Cloud lanes are off unless explicitly opted in. Every
  optional surface degrades cleanly when absent rather than escalating to a
  paid service.
- **Single source of truth.** `inventory.json` describes your hardware. Every
  other registry is generated from it and carries a `_generated` banner.

It ships as an MCP server (52 tools), a prompt/content layer (28 skills, 21
agents, 2 vendored packs), a standalone Python control plane for Hermes, and a
CLI.

### Scale

| Thing | Count |
|---|---|
| Tracked files | 906 |
| MCP tools registered | 52 (50 always, 2 behind a flag) |
| TypeScript source | ~18,200 lines (~34,000 including tests) |
| Test files / tests | 32 files, 547 tests (plus 83 Python tests) |
| Runtime skills | 28 |
| Runtime agents | 21 (+2 nano variants) |
| Build/check scripts | 23 in `xx-stack/scripts`, 6 in `packs/design/scripts` |
| Brand design systems | 151 (vendored, pinned to `e1c277c`) |

These counts drift. Regenerate them rather than trusting them:
`perl -0777 -ne 'print "$1\n" while /server\.registerTool\(\s*"([^"]+)"/g' xx-stack/mcp-server/src/*.ts | sort -u | wc -l`
for tools, `npm test` for the suite size, `git ls-files | wc -l` for the total.

---

## 2. Repository topology

Three top-level components:

```
xx-stack/                  ← THE SOURCE OF TRUTH
  mcp-server/              MCP server (TypeScript, ESM)
  runtime/                 canonical skills, agents, runbooks, registries
  adapters/                GENERATED mirrors of runtime/agents — never hand-edit
  scripts/                 build, check, and sync tooling
  packs/                   vendored content (design, rules)
  hooks/                   example lifecycle hooks

opencode-orchestration/    OpenCode-specialized surface
  opencode/                COPIES of runtime/ content, specialized for OpenCode
  vscode/                  VS Code prompt surfaces
  mcp-server -> ../xx-stack/mcp-server    (symlink)
  scripts    -> ../xx-stack/scripts       (symlink)
  packs      -> ../xx-stack/packs         (symlink)

hermes-orchestration/      standalone Python control plane (stdlib only)
```

### The symlink/copy distinction — read this before editing

This trips people up constantly, and the root README currently overstates it
(see §11, DOC-5).

- `opencode-orchestration/{mcp-server,scripts,packs}` are **symlinks**. Editing
  "through" them edits the real file in `xx-stack/`. Make the edit at the real
  path so the diff is legible.
- `opencode-orchestration/opencode/{agents,skills}` are **full copies**. Edits
  do **not** propagate. Changing a canonical skill means changing its mirror
  too, by hand.

There are 15 symlinks in the repo, all tracked as git mode `120000`, all
resolving correctly. `verify-repo-layout.mjs` asserts the structure.

### Why the copies exist

The canonical `runtime/` content is host-agnostic. The `opencode/` copies are
specialized: they pin models, rewrite `runtime/` paths to `opencode/`, and use
OpenCode's permission syntax. The deliberate deltas between a canonical file and
its mirror are:

1. the `compatibility:` frontmatter line
2. `model:` pins
3. `runtime/` → `opencode/` and `adapters/` → `vscode/` path rewrites
4. `skill: allow` → `skill: {"*": allow}`

**Anything else that differs is drift**, and `npm run drift:check` now reads
file *contents* to catch it, not just directory names. It did not always: §11
records the drift that blindness allowed, including an agent mirror missing 120
lines of behavioral guardrails. There is a real fifth delta — a pinned mirror
describes its lane in its own words — which the check waives narrowly and
prints on every run; see §9.

---

## 3. The single source of truth: inventory.json

`inventory.json` at the repo root is the only file you edit to describe
machines, networks, installed runtimes, and optional services.

```
inventory.json  ──(npm run inventory:sync)──►  xx-stack/runtime/platforms.json
                                          ├──►  opencode-orchestration/opencode/platforms.json
                                          └──►  hermes-orchestration/config/orchestration.json
                                                (only the `lanes` block and cloud-gate fields;
                                                 `execution` and `proxy` stay hand-tuned)
```

`npm run inventory:check` fails the build if any generated file is stale. Run
`npm run inventory:sync` after **any** change to inventory, the schema, or the
generator.

Note the deliberate asymmetry: `xx-stack/runtime/platforms.json` is generated
from `inventory.example.json`, not your real `inventory.json`, so a clone never
ships the maintainer's hardware.

### Schema shape

- `machines[]` — id, network address, `runtimes[]` (kind, port, models), and an
  optional `services[]` array (currently only `kind: "reader"`; off by default,
  never routed as a lane, never dialed by the MCP server).
- `aggregators[]` — proxies that front several runtimes.
- `cloud` — cloud providers, gated.
- `policy.cloudEscalation.optIn` — the master cloud gate.

Adding support for a new inference server means one entry in the `RUNTIMES`
table in `xx-stack/scripts/generate-registries.mjs` and one value in the `kind`
enum in `inventory.schema.json`. `endpointFamily` (how TypeScript inspects
models) and `hermesEndpointType` (how Hermes dials it) are deliberately
separate — Ollama is its own family to TypeScript but plain
`openai_compatible` to Hermes.

### Tier vocabulary

`xx-stack/runtime/runtime-constants.json` is the authority. There are exactly
four tiers:

```
local, tailscale-ollama, tailscale-openai-compatible, cloud
```

Several documents invent tiers that do not exist (`primary`, `reasoning`,
`overflow`, `compatibility`) — see §11, CONTENT-4. If you read those names
anywhere, they are wrong.

---

## 4. The MCP server

`xx-stack/mcp-server/` — TypeScript, ESM (`"type": "module"`), zero runtime
dependencies beyond the MCP SDK and zod.

### Conventions that are load-bearing

- **ESM imports carry `.js` extensions** even in TypeScript source.
  `import { x } from "./foo.js"` resolves `foo.ts`.
- **Tools register in groups.** A module exports
  `registerXxxTools(server, deps)`, calls `server.registerTool(name, config,
  handler)` inside, and is wired from `src/index.ts`. `routing_tools.ts` is the
  canonical shape to copy:

  ```ts
  server.registerTool(
    "route_task",
    {
      description: "…",
      inputSchema: { description: z.string().describe("…") },
      annotations: toolAnnotations("route_task"),
    },
    async ({ description }) => jsonContent(routeTask(description, registry))
  );
  ```

  **Never `server.tool(...)`.** Every one of its overloads is marked
  `@deprecated Use registerTool instead` in `@modelcontextprotocol/sdk ^1.28`,
  and it cannot express `title`, `outputSchema`, or the annotations below. A
  test asserts zero `server.tool(` call sites remain.
- **Every tool declares all four annotations** — `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint` — sourced from
  `toolAnnotations(name)`, never spelled inline. Clients use these to
  auto-approve reads and gate writes; undeclared, `list_platforms` (a registry
  read) and `verify_edit` (a subprocess spawn) look equally dangerous, which is
  the opposite of the `agent_filter_tools` / `toolPolicy` story. The hints are
  declared on the tool's `TOOL_CATALOG` entry so there is **one** place per tool
  — a separate annotation map would be MCP-13 all over again. An undeclared tool
  falls back to `destructiveHint: true, openWorldHint: true`: the gate fails
  closed, like `cloudRoutingAllowed()`. `openWorldHint` means *reaches beyond
  this machine* — health probes and endpoint compatibility checks do; a store
  read does not.
- **Runtime logic lives in `*_runtime.ts`; tools are thin wrappers.** The CLI
  imports the same runtime functions the tools call, so behavior cannot fork.
  (Three violations of this rule are recorded in §11, MCP-DUP-3.)
- **Tests are `*.test.ts` beside the runtime file**, using `node:test`. They run
  against compiled output: `npm test` = `tsc` then `node --test dist/*.test.js`.
- **Zero new dependencies** without justification. Prefer `node:` built-ins —
  the repo uses `node:test` over jest and `node:util` `parseArgs` over an
  argument parser.

### Module map

| Module | Lines | Role |
|---|---|---|
| `index.ts` | — | wires every tool group; the only place `register*` is called |
| `routing_selection_runtime.ts` | 838 | tier scoring, model choice, the cloud gate |
| `routing_runtime.ts` | 488 | architect/editor split, competitive fan-out, review routing, batch fan-out |
| `routing_tools.ts` | — | 7 routing tools |
| `supervisor_completion_tools.ts` | 1557 | continuation/handoff/forced-synthesis prompts, completion gate |
| `supervisor_session_tools.ts` | 777 | `supervisor_tick`, failover, lease revocation |
| `supervisor_session_runtime.ts` | 403 | stall detection, backoff, dedupe |
| `supervisor_store_runtime.ts` | 384 | session persistence |
| `task_runtime.ts` | 560 | task store, goal contracts, leases |
| `task_tools.ts` | 583 | 6 task tools |
| `memory_runtime.ts` | 758 | agent memory, budgeted recall, compaction, CAS writes |
| `execution_policy.ts` | 705 | the exec gate: denylist → allowlist → process-group spawn |
| `observability_tools.ts` | 1101 | platform listing, health, telemetry, tool search |
| `cli.ts` | 693 | the `xx` CLI |
| `repo_map_runtime.ts` | 1159 | budget-fitted repo map |
| `context_selection_runtime.ts` | — | lazy-greedy submodular selection |
| `output_compaction.ts` | — | head/tail truncation |
| `hook_tools.ts` | — | `_Stop` / `_PostCompact`, flag-gated |
| `platform_runtime.ts` | — | registry load, hardware probe, cost lookup |
| `config_runtime.ts` | 425 | agent profile merge, tool policy |

### The execution gate

Every shelling-out path goes through `validateExecRequest` in
`execution_policy.ts`. The order is:

1. **Denylist** — `xx-stack/runtime/dangerous-patterns.txt`, 12 POSIX-ERE
   patterns covering irreversible operations (`rm -rf /`, `dd` to a block
   device, `mkfs`, fork bombs, `curl | sh`, `git push --force`, repo deletion).
   Fails open if the file is unreadable, so a broken list never bricks the
   server — the state is flagged via `getDangerousPatternsStatus()`.
2. **Allowlist** — context-specific. Internal probes have their own list; hook
   commands take an explicit `allowedHookCommands`.
3. **Spawn** — detached on POSIX so the whole process group can be killed with
   SIGTERM-then-SIGKILL on every exit path, including normal completion.
   Windows has no process groups and degrades to signalling the direct child.

This is a **seatbelt against accidents, not a sandbox against a malicious
agent.** It blocks only irreversible operations; locally destructive but
recoverable commands (`rm -rf node_modules`, `git clean -fdx`) stay allowed
deliberately, because over-blocking kills agent usefulness. Document that limit
honestly wherever you describe it.

---

## 5. Tool reference

52 registrations across 13 modules. All names unique; every group reachable
from `index.ts`.

### Routing (7) — `routing_tools.ts`

| Tool | Purpose |
|---|---|
| `route_task` | the core call: description → tier, host, model, reasoning, fallback |
| `route_task_with_watchdog` | as above, plus live health probes and ranked fallbacks |
| `route_parallel_tasks` | fan a decomposed task list across lanes |
| `route_architect_editor` | two-lane split: reasoning model plans, fast model applies |
| `route_competitive_task` | N distinct lanes for the same prompt, each with a worktree path |
| `route_review` | picks a reviewer lane whose model differs from the author's |
| `score_candidates` | ranks competing diffs heuristically |

`route_task`, `route_architect_editor`, and `route_competitive_task` accept a
**string or an array**. Single input returns today's exact shape; array input
returns `{results: [...]}` position-aligned, fanned out with concurrency capped
at 8.

Cloud is excluded from all of them unless `XX_STACK_ALLOW_CLOUD=1` or
`selectionPolicy.cloudEscalation.optIn` is set.

### Tasks (6) — `task_tools.ts`

`task_create`, `task_get`, `task_list`, `task_update`, `task_suspend`,
`task_resume`.

Two optional metadata blocks matter:

- **`goalContract`** — `{objective, constraints[], validationCmd?,
  stopCondition, docsNote?, metric?, baseline?, maturity?, parentEligible?,
  canaryCmd?}`. When present, completion evaluation cites the
  stop condition and expects a `verify_edit` result for the validation command.
  Carries a mandatory anti-reward-hacking clause: *do not delete, skip, weaken,
  or narrow tests to make the goal pass.* Metric direction `unknown` stays
  unknown and cannot confirm; a missing value is never stored as 0. A canary
  command (defaulting to `validationCmd`) must run on the unchanged tree
  before `generation_open`; `could_not_run` blocks fan-out.
- **`lease`** — `{expiresAt, revoked?}`. Failover revokes the prior lane's
  lease; a write-back against a dead lease returns a structured `lease_revoked`
  rejection.

### Evidence (5) — `finding_tools.ts`

`finding_record`, `finding_list`, `generation_open`, `generation_close`,
`generation_status`.

Findings have a **result vs finding** split and three lanes: `confirmed`
(parent-eligible), `incubator` (promising, including force-synthesized
salvage), `diagnostic` (failures, canaries, mechanism contracts). Requested
lane is a hint; `assignLane` is the policy. After `generation_close`, new
records that name that generation stay visible as late signals and cannot
rewrite committed membership. The server still does not dispatch work.

### Supervisor (11) — three modules

Session lifecycle: `supervisor_start_session`, `supervisor_tick`,
`supervisor_record_event`, `supervisor_abort_session`.

Completion: `supervisor_complete_session`, `supervisor_record_completion_check`,
`supervisor_emit_continuation_prompt`, `supervisor_emit_handoff_prompt`,
`supervisor_force_synthesis`.

Inspection: `supervisor_status`, `supervisor_run_self_test`.

**Three terminal states**, deliberately distinguished: `completed`, `failed`,
and `force_synthesized`. The last is the "budget exhausted, salvage what we
learned" outcome — it demands an answer from existing evidence only, with
explicit confidence and unresolved gaps, and is never presented as a normal
completion.

**Prompt variants** all come from one formatter: `default`, `handoff` (state
not instructions, with a Traps & Dead Ends section and a verify-don't-trust
preamble), and `force_synthesis`. Secrets are redacted from rendered lines —
credential *locations* survive, values never do.

### Memory (6) — `agent_memory_tools.ts`

`agent_memory_append`, `agent_memory_get`, `agent_memory_snapshot_status`,
`agent_memory_snapshot_sync`, `agent_memory_compaction_prompt`,
`agent_memory_mark_superseded`.

- `agent_memory_get` takes an optional `tokenBudget`; when supplied, entry
  selection uses submodular selection (relevant + diverse, not most-recent-N).
  Omitted, behavior is byte-identical to the original.
- Compaction never calls a model — it emits a distillation prompt plus
  candidates; the agent writes rules back and originals are marked superseded
  in place, never deleted.
- The two read-modify-write paths accept an optional `expectedHash`; on
  mismatch they return `write_conflict` with the current hash and write
  nothing.

### Agent profiles (5) — `agent_profile_tools.ts`

`agent_preflight`, `agent_list_profiles`, `agent_validate_profiles`,
`agent_filter_tools`, `build_coordinator_contract`.

### Observability (7) — `observability_tools.ts`

`list_platforms`, `list_models`, `get_hardware`, `check_health`,
`probe_endpoint_compatibility`, `record_telemetry`, `search_tools`.

Telemetry is **off by default** (`runtime/telemetry.json`, `enabled: false`).
When on, it writes lane, token counts, and estimated cost to a local JSONL
sink. Cost is estimate-only from `runtime/model-rates.json`; local lanes are 0.

### Repo map, verification, review (3)

- `build_repo_map` — ranked, budget-fitted slice of a codebase. Heuristic
  scoring (git recency, path proximity, reference counts), respects `.xxignore`
  and `.gitignore`, no network.
- `verify_edit` — runs lint/test through the exec gate, returns structured
  pass/fail with the failing tail. Keeps the full capture in a per-session
  scratch ring (8 entries, outside the repo) at `fullOutputPath`.
- `review_to_continuation` — diff + reviewer notes → continuation directive.

### Lifecycle hooks (2) — `hook_tools.ts`, **off by default**

Registered only when `XX_STACK_HOOK_TOOLS=1`. Absent from `tools/list`
otherwise.

- `_Stop` — a hook-aware harness calls this when the model signals end-of-turn.
  Empty string = no objection. Non-empty = keep working, naming the concrete
  unmet stop condition.
- `_PostCompact` — returns state to re-inject after context compaction, derived
  entirely from existing stores.

Both must respond fast (callers time out around 2.5s and treat timeout as no
objection) and must never emit text that reads as operator instructions — the
output lands at tool-result trust, not system trust.

---

## 6. The runtime layer: skills and agents

### Skills

Canonical: `xx-stack/runtime/skills/<name>/SKILL.md`. Indexed in
`xx-stack/runtime/SKILLS.md`, which also holds the **Skill Authoring
Contract**:

- The `description` is a routing contract — what, when, and the differentiator.
  Never a workflow summary; an agent that reads a step summary in the
  description skips loading the body.
- Match instruction strictness to task fragility: loose heuristics → templates
  → exact scripts.
- References go one level deep, never chained.
- Progressive disclosure: inline what every branch needs, link the rest.
- Test every skill against the weakest model it will run on.

Each skill must carry an activation contract (when to use, when not to), be
evidence-first, and declare explicit degradation.

### Guidance tiers

Five critical surfaces ship a `~2KB` nano variant containing decision rules and
gates only — no examples, no output templates:

- Skills: `review-code`, `debug-investigate`, `deploy-ship`
  (`SKILL.nano.md` beside the canonical)
- Agents: `execution-orchestrator`, `fast-build` (`<name>.nano.md`)

Hosts pick the variant by the lane's context window. `check-nano-tiers.mjs`
pins each canonical file's hash, so editing a canonical without reviewing its
nano fails CI.

### Agents

Canonical: `xx-stack/runtime/agents/<name>.md`, registered in
`xx-stack/runtime/config.json`. `xx-stack/adapters/agents/*.agent.md` are
**generated** — run `npm run agents:sync`, never hand-edit.

BUILD-1 (§11) records when this script hardcoded 8 agent specs and silently
skipped the rest; it now derives the expected mirror set from each component's
agent directory, with explicit opt-outs in its `NOT_MIRRORED` maps. A green
`agents:check` means every agent is mirrored or explicitly opted out.

---

## 7. Content packs

### `packs/design`

151 brand design systems, 57 aesthetic skill/design pairs, 31 workflow skills,
plus evals and its own gates. `DESIGN-CATALOG.md` is generated
(`npm run design:catalog`) and in sync.

Gates: `npm run design:golden` (5/5) and `npm run design:html-gate` (67/67, in
CI). Both green.

**This pack is vendored third-party content, not engineering authored here.**
That distinction matters for how you treat it. A byte-level audit found 138 of
151 `design-systems/` files identical to their source at the pinned commit
`e1c277c5`; the "Design System Inspired by Apple" framing in those files is the
source project's, not a description of work done here. Because the pack
redistributes that content, Apache-2.0's requirement to ship the license text
applies:

| Source project | License | Supplies |
|---|---|---|
| `nexu-io/open-design` | Apache-2.0 | 150 of 151 design systems, all 31 workflow skills |
| `bergside/awesome-design-skills` | MIT | all 57 design skills |
| `VoltAgent/awesome-design-md` | MIT | one file (`bmw-m`) |
| op7418 (歸藏) | MIT | `workflow-skills/guizang-ppt/` |

License texts live in `packs/design/licenses/`; per-subtree provenance —
including what could **not** be established — is in
`packs/design/manifest.json`. Open licensing questions are in §11.1.

**The gates over this pack, and the fixes to its content, are ours.**
`design:systems-lint` (§9) parses all 151 systems and found four shipping
illegible body text; those repairs, the `craft/` rule engine, and the HTML
quality gate were built here.

Not Prettier-formatted, by policy: reformatting vendored files would destroy
byte-comparability against their source, which is the only way to distinguish
a local edit from a change made upstream (`.prettierignore`). That comparison
is what the provenance record in the manifest is built on, and what makes a
future re-vendor safe.

### `packs/design/craft` — cross-cutting quality rules

11 brand-agnostic rulebooks vendored byte-identical from `nexu-io/open-design`
at `dceac12` (typography ×3, color, anti-ai-slop, state-coverage, animation
discipline, accessibility baseline, RTL/bidi, form validation, laws of UX).
A third axis alongside brand systems (what a brand looks like) and workflow
skills (how to build an artifact type): rules that hold regardless of brand.

Skills opt in per-file via `od.craft.requires`, so a skill pays context tokens
only for the rulebooks it names. `design:craft-refs` fails when a slug does not resolve.

**Licensing has two hops and they are scoped differently.** The subtree is
Apache-2.0 from open-design. Three of the 11 rulebooks additionally derive from
`referodesign/refero_skill` (MIT) and say so inline; the other eight postdate
that README's blanket claim and carry no attribution. Both license texts ship.
The narrower reading is recorded in `manifest.json` rather than by editing the
vendored README.

`craft/anti-ai-slop-rules.json` holds 18 rules as **attributed data** read by an
MIT engine written here — no third-party code is compiled in, which keeps the
licence boundary at the pack boundary. Two sources feed the values, tagged per rule
(open-design and `google-labs-code/stitch-skills`), and 15 refusals are recorded
with reasons. Two worth knowing: the pure-black ban was refused because 59 of
our 151 design systems name `#000000` as deliberate brand vocabulary, and the
the two sources flatly disagree about `picsum.photos` — one bans it, the other
recommends it. The ban was kept and the disagreement recorded, so it does not
read as an oversight.

### How `packs/rules` reaches a model

This is worth stating plainly because it was broken until 2026-08-03 and the
failure was invisible.

**No code reads this pack.** There is no loader, no injection, nothing in the
MCP server or the scripts that opens a rule book. `rules:check` validates that
the 49-entry coverage map matches the skill and agent surface — it proves the
*map* is complete, not that anything consumes it.

The only delivery path is the instruction each covered skill and agent carries.
Until 2026-08-03 that instruction was a bare noun phrase on the last line of the
file — `Rule book: packs/rules/refactoring/refactoring.mini.md` — with no verb,
no trigger, and no placement. An agent finishing a 150-line skill had nothing
telling it to open another file, so the books were almost certainly never read.

All 62 are now imperative, sited at the decision the book would change, naming
the assigned tier and its token cost:

> Before you write a structural finding or change a line yourself, read
> `packs/rules/refactoring/refactoring.mini.md` and judge the change against its
> decision rules. It is ~1,300 tokens of smell vocabulary and safe-change
> discipline, not a book summary — it separates a real S2 from a matter of
> taste, and it catches the case where a "cleanup" in the diff has quietly
> changed behavior.

Two rules that came out of doing it. **Cost is stated, never hedged** — "consider
reading if you have budget" guarantees the instruction is skipped, which is how
the citation form failed. And **nano tiers are decided per surface, not by
symmetry**: `fast-build` takes a ~309-token nano book, `execution-orchestrator`
takes none, because its assigned `mini` is three times the size of the entire
nano file and a lane that cannot afford the canonical skill certainly cannot
afford that.

**The coverage map has never been validated for fit.** `rules:check` proves every
skill and agent has an entry; nothing checks the entry is the *right* book.
Rewriting the instructions surfaced three weak assignments — see §11.1.

### `packs/rules`

11 software-engineering books distilled into decision rules, vendored from
`ciembor/agent-rules-books` (MIT) at commit `9c87636`, each in three tiers:

| Tier | Size | Use |
|---|---|---|
| `nano` | ~300–650 tokens | tight lanes |
| `mini` | ~950–1800 tokens | default |
| `full` | ~2800–15600 tokens | reference |

`manifest.json` records tier paths, token estimates (bytes/4), and the
compatibility matrix. `coverage.json` maps all 49 skills and agents to their
book set — including **explicit empty entries**, so absence is a decision
rather than an omission. `check-rules-coverage.mjs` fails when a skill or agent
is added without a coverage entry.

Two rules the coverage map enforces: never assign two books the manifest marks
conflicting, and collapse overlapping sets to one.

---

## 8. The Hermes subsystem

`hermes-orchestration/` — Python 3.11+, **standard library only**, no
dependency on the TypeScript stack.

It routes LLM requests across self-hosted lanes with a premium cloud fallback
via a local `hermes` CLI, and exposes a loopback-only OpenAI-compatible proxy.

### Commands

```
health          lane health across the fleet
route           show the routing decision without executing
run             execute a task on the chosen lane
subagents       fan a "A||B||C" task list across lanes
presets         list named routing presets
inventory       model inventory, with --probe-tool-calls
refresh-cache   refresh the capability cache
bench           benchmark lanes
serve           run the loopback OpenAI-compatible proxy
```

### The proxy

```bash
export HERMES_PROXY_TOKEN="$(openssl rand -hex 24)"
python3 scripts/hermes_orchestrator.py serve
# → http://127.0.0.1:8180
```

Endpoints: `GET /healthz` (no auth), `GET /v1/models`,
`POST /v1/chat/completions`. Binds loopback only; a bearer token is mandatory
unless `--no-auth` is passed explicitly; a non-loopback bind prints a warning.
`stream: true` gets a single-chunk SSE shim — the upstream call is
non-streaming.

A user systemd unit ships at `systemd/hermes-proxy.service`, reading its token
from `~/.config/hermes-orchestration/proxy.env`.

### Safety model

The execution path is double-gated: `--execute-approved` **and**
`execution.allow_shell_execution` (shipped `false`) are both required.
Commands run with `shell=False` after argv-level allowlist matching, so shell
metacharacters can never expand.

**Understand the limit:** the allowlist matches a command prefix and then
permits every remaining argument. Several plausible allowlist entries
(`find`, `rg`, `cat`) accept arguments that spawn processes or read arbitrary
files. See §11, HERMES-1 for what was done about this.

---

## 9. Gates, CI, and what they actually prove

### `npm run verify`

```
layout:verify → agents:check → drift:check → rules:check → nano:check
              → inventory:check → guardrails:check → ci:parity → lint
              → format:check → design:golden → design:html-gate
              → design:systems-lint → design:craft-refs
              → design:anti-slop-test → test → hermes:test
```

| Gate | What it proves | Blind spot |
|---|---|---|
| `layout:verify` | component layout, symlinks, executable bits, and every vendored rulebook and license file by name (54 checks) | only the layouts it knows; an unmapped directory is invisible — this is how `xx-stack/vscode/` rotted, and how `packs/design/craft/` was briefly deletable without failing a gate |
| `agents:check` | every canonical agent is mirrored or explicitly opted out | — (was 8 of 21 before the audit) |
| `drift:check` | names **and content** of 63 mirrored pairs, after normalizing the deliberate deltas | waived deltas — see below |
| `rules:check` | coverage map matches the skill/agent surface | — |
| `nano:check` | nano variants exist, under cap, canonical hashes pinned, mirrors identical | — |
| `inventory:check` | generated registries are current | — |
| `guardrails:check` | denylist patterns behave; file hash pinned | pattern *coverage* — it proves the listed patterns work, not that the list is complete |
| `ci:parity` | every gate in the verify chain has a matching step in ci.yml | deliberately one-directional — CI legitimately runs more than verify (audit, catalog, Node matrix) |
| `lint` | `.ts`, `.mjs`, and `.js` | — |
| `format:check` | `mcp-server/src` and `scripts` only | everything else, deliberately (`packs/` is vendored) |
| `design:golden` / `design:html-gate` | design pack evals; 67 generated HTML artifacts against 18 attributed anti-slop rules | rules the two rule sources disagree on, and 15 refused rules — both recorded in `craft/anti-ai-slop-rules.json` |
| `design:craft-refs` | every `od.craft.requires` slug resolves to a rulebook | — |
| `design:anti-slop-test` | each rule fires at its declared severity on slop fixtures and not on clean ones | — |
| `design:systems-lint` | all 151 design systems parse, order their sections, and pair text with surface at AA | accent-on-surface is reported, never failed — 14 sit below 3:1 and those are upstream design choices, not defects |
| `test` | MCP suite | see §11 for the classes it historically missed |
| `hermes:test` | Python suite, against the *shipped* allowlist | — |

**How `drift:check` reads content, and what it waives.** It used to compare
directory *names* only, which is how every content-drift defect in §11 got in —
including an agent mirror missing 120 lines of concurrency and spawn-depth caps.
It now diffs 63 mirrored pairs after normalizing the deltas from §2, and runs
that way by default (`--names-only` / `--content-only` exist for debugging).

Anything it cannot normalize is either a failure or an **exact-match** waiver
carrying a written reason. That distinction is the whole design: a regex loose
enough to absorb the legitimate differences would absorb real drift too, which
is the bug this gate exists to prevent. Two waiver classes to know about:

- **The pinned-lane `description:` line** is a real fifth delta — a mirror that
  pins a model describes that lane in its own words. It is waived *only* when
  the mirror has a pin the canonical side lacks, it is printed as a `NOTE` on
  every run rather than hidden, and the first three words must still match, so
  the waiver covers the lane wording and not a rewrite of what the agent is.
- **`OPEN` entries** are unresolved differences a human has to adjudicate. They
  are waived so the gate stays usable and printed in full every run. There are
  currently none. The one that existed — the `design-system-pick` prompts
  disagreeing about two design systems — was adjudicated and closed rather than
  re-waived; see §11.2. The mechanism stays: a divergence nobody can classify
  yet belongs here, visible, not absorbed into a looser regex.

A new mirrored top-level document must be classified as gated or explicitly
excluded, or the check fails — that is how a runbook drifted 90 lines
undetected.

### What `verify` still does NOT cover

`typecheck` as a named step (though `npm test` runs `tsc` first, so type errors
do fail), `design:catalog` staleness (it mutates the tree, so CI checks it
separately), and the Node 20/22 matrix. Treat CI as the final authority.

### One gate limit worth knowing

`design:html-gate` runs in **sweep mode** in CI — no `--skill` argument. That is
deliberate and correct: a directory sweep is looking at seeds and reference
examples, not at deliverables, and holding a sprite sheet to deliverable
criteria would be wrong. But it has a consequence worth stating plainly.

The four *acceptance* criteria — `minSectionCount`, `mustHaveH1`, `mustHaveCta`,
`requiredAny` — only fire when a caller names a skill, which is how an agent
invokes the gate on its own output. In CI they never run, so **they have no
regression coverage**. They are correct rules with no test protecting them.

The category flag `requireSemanticLayout` is different and does fire in sweep,
because "what kind of surface is this" is as true of a seed as of a deliverable.

Related: `mustNotInclude` appears in `quality-gates.json`-adjacent config but is
read **only** by `evaluate-golden-tasks.mjs`. The HTML gate implements four
profile keys and that is not one of them, so adding it to a profile produces
dead config that reads like a working rule.

### Every mirror surface is now gated

`agents:check` covers **36 mirrors across both components** — it drives
`runtime→adapters` and `opencode→vscode` from the same component map
`verify-repo-layout.mjs` uses, deriving each set by reading the agent directory.
`vscode/agents/` used to be hand-maintained with no sync and no check; when
generation was switched on it turned out 8 of 18 agents were covered and the
bodies were 20–45% shorter than their source — the same defect class as §11
CONTENT-2, live on a surface `setup-vscode.sh` copies into users' prompt
directories.

`adapters/skills` ↔ `vscode/skills` are hand-maintained on both sides (nothing
generates either) and are gated by the content check instead.

Pack content beyond the design pack's own two gates remains ungated, which is
acceptable for vendored material — see `packs/design/manifest.json` for what it
is and where it came from.

### The pre-commit hook

`.githooks/pre-commit` runs the agent mirror check and nothing else. Enable it
with `git config core.hooksPath .githooks`.

---

## 10. Configuration reference

### Environment variables

| Variable | Effect |
|---|---|
| `XX_STACK_REPO` | repo root override; defaults to `~/.config/opencode/skills/xx-stack` |
| `XX_STACK_ALLOW_CLOUD` | `1` opts into cloud lanes |
| `XX_STACK_HOOK_TOOLS` | `1` registers `_Stop` / `_PostCompact` |
| `XX_STACK_DANGEROUS_PATTERNS_FILE` | override the denylist path |
| `XX_STACK_SCRATCH_DIR` | base for `verify_edit` full-output artifacts |
| `XX_STACK_HOOK_EVENT/_SESSION_ID/_TASK_ID` | passed to lifecycle hooks |
| `HERMES_PROXY_TOKEN` | bearer token for the Hermes proxy |
| `HERMES_PRIORITY` | lane priority override |

A family of `XX_STACK_BENCH_*`, `XX_STACK_OLLAMA_*`, `XX_STACK_LLAMA_CPP_*`,
and threshold variables drive the reliability harness and promotion gates.

### Key files

| Path | Role | Edit? |
|---|---|---|
| `inventory.json` | hardware truth | **yes — the only one** |
| `xx-stack/runtime/platforms.json` | generated registry | no |
| `opencode-orchestration/opencode/platforms.json` | generated registry | no |
| `hermes-orchestration/config/orchestration.json` | `lanes` generated; `execution`/`proxy` hand-tuned | partially |
| `xx-stack/runtime/config.json` | agent registration, permissions | yes |
| `xx-stack/runtime/telemetry.json` | telemetry sink; off by default | yes |
| `xx-stack/runtime/model-rates.json` | cost estimation table | yes |
| `xx-stack/runtime/dangerous-patterns.txt` | exec denylist | yes, with tests |
| `.xxignore` | agent *context* boundary | yes |
| `.gitignore` | what must not be committed | yes |

`.xxignore` and `.gitignore` are different boundaries. `.xxignore` tells agents
what not to sweep into context; `.gitignore` governs commits. A large vendored
or generated surface belongs in both.

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
| `drift:check` printed an `OPEN` waiver every run for the `design-system-pick` brand list. | Resolved as a rotted list, with git evidence: `d458c02` removed `` from both copies symmetrically but *added* two entries to only one. Five slugs were broken; **all 121 brand ids now resolve**, where five brands were previously unselectable by any agent — including the one the waiver was arguing about, which was itself a wrong slug. |
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
| `design-system-pick` prompt: the OpenCode copy listed `ollama` and `opencode` design systems the xx-stack copy omitted — the register's one `OPEN` drift waiver. | Adjudicated as a rotted list, not de-branding, on git evidence. `d458c02` ("dedupe, de-brand, fix CI") touched both copies in one commit: it removed `` from **both** — that was the de-branding, and no `/` directory exists to select anyway — and added `ollama`/`opencode` to the OpenCode copy **only**. The canonical copy was simply missed. De-branding also could not explain it, because both components resolve `packs/design` to the same directory (`opencode-orchestration/packs/design` is a symlink), so there is no per-component brand subset. A brand in the pack but absent from the list is unselectable, which makes this a functional gap. Both copies now list `ollama` and `opencode-ai`. The same pass found the enumerated ids had never been validated against the tree: `mistral`, `runway`, `linear`, `the-verge`, and the newly-added `opencode` resolved to nothing — corrected to `mistral-ai`, `runwayml`, `linear-app`, `theverge`, `opencode-ai`. Every id in both copies now resolves to a directory. The dead `KNOWN_DELTAS` entry was deleted rather than left to rot, and `drift:check` prints no `OPEN` line. |
| `log_worker.logEvent` swallowed every write error. | The policy question is answered: **telemetry never fails a caller's operation** — it is an observability sink, and a metrics failure taking down routing would be absurd. Silence is the part that was wrong. `logEvent` still never throws, but it now returns a `LogEventResult`, counts failures in `telemetryHealth()`, and announces each distinct failure once on stderr (stdout is the MCP channel). `record_telemetry` reports `durability: "failed"` with the reason instead of always claiming `best-effort`, and surfaces the process-lifetime counter — the only trace the 24 fire-and-forget `void logEvent(...)` call sites ever leave. The `dirEnsured` latch is cleared on failure, so a deleted log directory is re-created instead of killing telemetry for the life of the process. |
| `hardwareCache` cached partial probe results permanently. | Per-probe memoization. A probe that succeeds never runs again; a probe that fails is retried on the next call until it has failed 3 times, then treated as genuinely absent. A fully-successful call is still cached wholesale, so the common path is unchanged at three `execFile`s once. An unavailable probe still leaves its field unset rather than throwing. |
| `search_tools` categories were a stretch for some tools. | The enum was widened with `context` and `verification`, and `build_repo_map` / `verify_edit` were re-filed out of `observability`. It is a schema change, but an additive one on a *discovery* surface: the five original values still validate and the filter is optional. `TOOL_CATALOG` stays curated — see the comment above it for the measured reasons derivation from the registrations was rejected. |

---

## 12. Maintenance conventions

### Adding an MCP tool

1. Put pure logic in `<area>_runtime.ts` with a `*.test.ts` beside it.
2. Register the tool in `<area>_tools.ts` inside the existing
   `registerXxxTools`, using
   `server.registerTool(name, {description, inputSchema, annotations}, handler)`.
   Never `server.tool(...)` — every overload of it is `@deprecated` in the SDK
   we ship, and a test fails on any remaining call site.
3. Wire the group in `index.ts` only if it is a new group.
4. Add the tool to `TOOL_CATALOG` in `observability_tools.ts` — deliberately
   manual (see §13 for why), and gated by a drift test since MCP-13. Pick a
   category from `TOOL_CATEGORIES`, or add one; do not mis-file it.
5. Declare all four annotations **on that same catalog entry**, and pass them at
   the registration site as `annotations: toolAnnotations("<name>")`. One place
   per tool: a parallel annotations map is exactly the second registry MCP-13
   was. Decide each hint rather than copying a neighbour's — `readOnlyHint`
   (does it change anything?), `destructiveHint` (does it overwrite, or only
   append?), `idempotentHint` (is a repeat call a no-op?), `openWorldHint` (does
   it reach off this machine?). The drift test fails if a registered tool has no
   declaration, and a tool with no declaration is treated as destructive and
   open-world — the gate fails closed.
6. `npm run verify`.

### Adding a skill

1. `xx-stack/runtime/skills/<name>/SKILL.md` with the frontmatter contract.
2. Mirror to `opencode-orchestration/opencode/skills/<name>/SKILL.md`, applying
   only the four deliberate deltas.
3. Register in `xx-stack/runtime/SKILLS.md` **and** the OpenCode twin.
4. Add a `packs/rules/coverage.json` entry — an explicit `books: []` if no rule
   book applies. `rules:check` fails without one.
5. `npm run verify`.

### Adding an agent

1. `xx-stack/runtime/agents/<name>.md`, register in `runtime/config.json`.
2. Mirror to the OpenCode tree and register there too.
3. `npm run agents:sync`.
4. Coverage entry, then `npm run verify`.

### Changing hardware

Edit `inventory.json` only. Then `npm run inventory:sync` and
`npm run inventory:check`.

### Changing the exec denylist

Edit `xx-stack/runtime/dangerous-patterns.txt` **and**
`xx-stack/scripts/check-dangerous-patterns.mjs` in the same commit — the script
pins the file's hash, so a pattern change without a test update fails CI. That
coupling is deliberate.

### Iron rules

- `inventory.json` is the only hardware truth.
- Never hand-edit `xx-stack/adapters/agents/*`.
- Never add a code path that reaches a cloud provider without passing through
  `cloudRoutingAllowed()`, and never change its default.
- New runtime dependencies in `mcp-server` need justification; prefer `node:`
  built-ins.
- No silent truncation or silent capping anywhere — log what was dropped.

---

## 13. Troubleshooting

**`inventory:check` fails / "generated file is stale."** Run
`npm run inventory:sync`. This also fires if Prettier reformatted a generated
registry — regenerate rather than hand-editing.

**`drift:check` passes but the OpenCode surface behaves differently.** Expected:
that gate compares names, not content. Diff the pair by hand, normalizing the
four deliberate deltas.

**`agents:check` fails on an agent I just added.** Working as intended. The
check derives its set from the directory, so a new agent must either be mirrored
(`npm run agents:sync`) or added to the `NOT_MIRRORED` opt-out in
`sync-vscode-agents.mjs` with a reason. Silence used to be the failure mode
here; noise is the fix.

**A tool is registered but `search_tools` can't find it.** Add it to
`TOOL_CATALOG` in `observability_tools.ts`. The catalog is hand-written on
purpose: deriving it from the `registerTool(name, config, ...)`
registrations was measured and rejected — 30% of the search keywords appear
nowhere in the registration prose, nothing there names a category, and the
registration text is 2.6x the bytes because it is written for a model about to
*call* the tool, not to be listed in a result set. The reasoning and the numbers
are in the comment above `TOOL_CATALOG`; don't re-litigate it without new ones.
A test fails when a registered tool has no entry, so you will hear about it
before CI does. Deliberately hidden tools (`_Stop`, `_PostCompact`) belong in
the test's exemption set, not the catalog. If the tool is not observability,
routing, supervision, a task, or an agent, add a category to `TOOL_CATEGORIES`
rather than mis-filing it — the zod filter is derived from that list.

**A client prompts for approval on a tool that only reads.** Its `TOOL_CATALOG`
entry is missing `readOnlyHint: true`, or the tool has no declaration at all and
picked up `FAIL_SAFE_TOOL_HINTS` (`destructiveHint: true, openWorldHint: true`).
The default is deliberate — an unannotated tool must not be auto-approved — but
shipping on it is not, and the annotation drift test fails on it. Fix the entry,
not the client.

**A store tool returns `store_unavailable`.** The state file exists but could
not be read or parsed. The payload carries the exact path and errno. This is
deliberate: the readers used to treat any read failure as "empty store", and
the next write would then persist that emptiness over your real state.
Fix or remove the file; do not expect the server to route around it.

**Routing always picks the same host.** Tier scoring is keyword-based; check
whether your description matches the keyword table in
`routing_selection_runtime.ts`. Note the seed strings used by
`route_architect_editor` may not score as intended.

**Cloud never gets selected.** By design. Set `XX_STACK_ALLOW_CLOUD=1` or
`policy.cloudEscalation.optIn` in `inventory.json`.

**The exec gate blocks something reasonable.** Check
`runtime/dangerous-patterns.txt` first, then the context-specific allowlist. The
denylist should only carry irreversible operations; if it is blocking something
recoverable, that is a bug in the list.

**Hermes proxy returns 502.** The response body carries an `attempts` array
with a per-lane reason, and the same reasons are now written to
`logs/routing.jsonl` along with an `ok: false` record — failed requests used to
be invisible in telemetry.

**A Hermes command I expect to be allowed is refused.** The allowlist screens
every argument, not just the command prefix: flags that spawn processes
(`-exec`, `--pre`, `--ext-diff`) are denied outright, and every path argument
must resolve inside the working directory. `find` and `rg` were removed from
the shipped list entirely — their escape hatches are too numerous and too
version-dependent for a denylist to be a boundary. Re-adding them is a
deliberate choice to trade safety for reach.

**Tests pass locally but CI fails.** `verify` now runs lint, format, and both
design gates, so this should be rare. The remaining gaps are the Node 20/22
matrix and `design:catalog` staleness (it mutates the tree, so CI checks it
separately).
