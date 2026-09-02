# xx-stack Manual

A complete reference for operating, extending, and maintaining this repository.

**Audience.** Someone who has to change this codebase or run it in anger. The
root `README.md` explains *why* the project exists and gets you to a first
routing decision in two minutes; this document explains *how everything works*
and *where the bodies are buried*.

**Status of this document.** Current as of 2026-09-01. The historical defect
register lives in `MANUAL-DEFECTS.md` (every confirmed problem, what it broke,
and its status). Everything there is **fixed** unless a row says otherwise; the
open items are judgment calls, not unfixed bugs. This file is the operating
manual.

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
11. [Defect register](#11-defect-register) (`MANUAL-DEFECTS.md`)
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

It ships as an MCP server (routing, supervision, tasks, memory, evidence), a
prompt/content layer (skills, agents, 2 vendored packs), a standalone Python
control plane for Hermes, and a clone-only CLI (`node mcp-server/dist/cli.js`).
OpenCode is the install layer. There is no shipped VS Code product surface.

### Scale

| Thing | Count |
|---|---|
| Tracked files | regenerate with `git ls-files \| wc -l` |
| MCP tools registered | 33 always-on + 2 hooks behind `XX_STACK_HOOK_TOOLS=1`; `XX_STACK_TOOL_SURFACE=routing` keeps 5 |
| TypeScript source | regenerate with `wc -l mcp-server/src/*.ts` |
| Test files / tests | `npm test` and `npm run hermes:test` |
| Runtime skills | 29 |
| Runtime agents | 21 (+2 nano variants) |
| Build/check scripts | 23 in `scripts`, 6 in `packs/design/scripts` |
| Brand design systems | 149 (vendored, pinned to `e1c277c`) |

These counts drift. Regenerate them rather than trusting them:
`perl -0777 -ne 'print "$1\n" while /server\.registerTool\(\s*"([^"]+)"/g' mcp-server/src/*.ts | sort -u | wc -l`
for tools, `npm test` for the suite size, `git ls-files | wc -l` for the total.

---

## 2. Repository topology

Three top-level components:

```
.                          ← git root; also the core component root
  mcp-server/              MCP server (TypeScript, ESM)
  runtime/                 canonical skills, agents, runbooks, registries
  scripts/                 build, check, and sync tooling
  packs/                   vendored content (design, rules)
  hooks/                   example lifecycle hooks

opencode-orchestration/    OpenCode-specialized surface
  opencode/                COPIES of runtime/ content, specialized for OpenCode
  mcp-server -> ../mcp-server    (symlink)
  scripts    -> ../scripts       (symlink)
  packs      -> ../packs         (symlink)
  hooks      -> ../hooks         (symlink)

hermes-orchestration/      standalone Python control plane (stdlib only)
```

### The symlink/copy distinction — read this before editing

This trips people up constantly.

- `opencode-orchestration/{mcp-server,scripts,packs,hooks}` are **symlinks**.
  Editing "through" them edits the real file at the git root. Make the edit at
  the real path so the diff is legible.
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
3. `runtime/` → `opencode/` path rewrites
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
inventory.json  ──(npm run inventory:sync)──►  runtime/platforms.json
                                          ├──►  opencode-orchestration/opencode/platforms.json
                                          └──►  hermes-orchestration/config/orchestration.json
                                                (only the `lanes` block and cloud-gate fields;
                                                 `execution` and `proxy` stay hand-tuned)
```

`npm run inventory:check` fails the build if any generated file is stale. Run
`npm run inventory:sync` after **any** change to inventory, the schema, or the
generator.

Note the deliberate asymmetry: `runtime/platforms.json` is generated
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
table in `scripts/generate-registries.mjs` and one value in the `kind`
enum in `inventory.schema.json`. `endpointFamily` (how TypeScript inspects
models) and `hermesEndpointType` (how Hermes dials it) are deliberately
separate — Ollama is its own family to TypeScript but plain
`openai_compatible` to Hermes.

### Tier vocabulary

`runtime/runtime-constants.json` is the authority. There are exactly
four tiers:

```
local, tailscale-ollama, tailscale-openai-compatible, cloud
```

Several documents invent tiers that do not exist (`primary`, `reasoning`,
`overflow`, `compatibility`) — see §11, CONTENT-4. If you read those names
anywhere, they are wrong.

---

## 4. The MCP server

`mcp-server/` — TypeScript, ESM (`"type": "module"`), zero runtime
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
  against compiled output: `npm test` = `tsc` then `tsc -p tsconfig.test.json`
  then `node --test dist-test/*.test.js`. Production `dist/` does not contain
  tests or `test_exports`.
- **Zero new dependencies** without justification. Prefer `node:` built-ins —
  the repo uses `node:test` over jest and `node:util` `parseArgs` over an
  argument parser.

### Module map

| Module | Lines | Role |
|---|---|---|
| `index.ts` | — | wires every tool group; the only place `register*` is called |
| `routing_selection_runtime.ts` | 838 | tier scoring, model choice, the cloud gate |
| `routing_runtime.ts` | 488 | architect/editor split, competitive fan-out, review routing, batch fan-out |
| `routing_tools.ts` | — | `route_task` (modes) + `route_parallel_tasks` |
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

1. **Denylist** — `runtime/dangerous-patterns.txt`, 12 POSIX-ERE
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

33 always-on tools plus 2 lifecycle hooks. All names unique; every group
reachable from `index.ts`. `XX_STACK_TOOL_SURFACE=routing` keeps only
`list_platforms`, `check_health`, `route_task`, `route_parallel_tasks`, and
`search_tools` (and `search_tools` will not advertise the rest).

Continuation, failover-handoff, review-to-continuation, and memory-compaction
prompts are the `compose-supervisor-prompts` skill, not MCP tools. The
TypeScript formatters remain for tests.

### Routing (2) — `routing_tools.ts`

| Tool | Purpose |
|---|---|
| `route_task` | the core call: description → tier, host, model, reasoning, fallback. `mode` selects watchdog, architect-editor, competitive, or review |
| `route_parallel_tasks` | fan a decomposed task list across lanes |

`route_task` accepts a **string or an array**. Single input returns today's
exact shape; array input returns `{results: [...]}` position-aligned, fanned
out with concurrency capped at 8.

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

### Supervisor (8) — three modules

Session lifecycle: `supervisor_start_session`, `supervisor_tick`,
`supervisor_record_event`, `supervisor_abort_session`.

Completion: `supervisor_complete_session`, `supervisor_record_completion_check`,
`supervisor_force_synthesis`.

Inspection: `supervisor_status`.

**Three terminal states**, deliberately distinguished: `completed`, `failed`,
and `force_synthesized`. The last is the "budget exhausted, salvage what we
learned" outcome — it demands an answer from existing evidence only, with
explicit confidence and unresolved gaps, and is never presented as a normal
completion.

**Prompt variants** all come from one formatter: `default`, `handoff` (state
not instructions, with a Traps & Dead Ends section and a verify-don't-trust
preamble), and `force_synthesis`. Secrets are redacted from rendered lines —
credential *locations* survive, values never do.

### Memory (4) — `agent_memory_tools.ts`

`agent_memory_append`, `agent_memory_get`, `agent_memory_snapshot_sync`,
`agent_memory_mark_superseded`. Snapshot status is folded into
`agent_memory_get`. Compaction prompts are the `compose-supervisor-prompts`
skill.

- `agent_memory_get` takes an optional `tokenBudget`; when supplied, entry
  selection uses submodular selection (relevant + diverse, not most-recent-N).
  Omitted, behavior is byte-identical to the original.
- Compaction never calls a model — it emits a distillation prompt plus
  candidates; the agent writes rules back and originals are marked superseded
  in place, never deleted.
- The two read-modify-write paths accept an optional `expectedHash`; on
  mismatch they return `write_conflict` with the current hash and write
  nothing.

### Agent profiles (2) — `agent_profile_tools.ts`

`agent_preflight`, `agent_list_profiles`. Profile validation findings ship on
`agent_list_profiles`; `agent_preflight` filters a candidate tool set.

### Observability (4) — `observability_tools.ts`

`list_platforms`, `check_health`, `record_telemetry`, `search_tools`. Live
model catalogs, hardware detection, and OpenAI-compat probes are optional
`include` flags on `check_health`.

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
Review-to-continuation prompts are the `compose-supervisor-prompts` skill.

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

Canonical: `runtime/skills/<name>/SKILL.md`. Indexed in
`runtime/SKILLS.md`, which also holds the **Skill Authoring
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

Canonical: `runtime/agents/<name>.md`, registered in
`runtime/config.json`. OpenCode copies live in
`opencode-orchestration/opencode/agents/` and are gated by
`npm run drift:check` — never treat the copies as canonical.

Inside OpenCode the shipped host contract is
`opencode/config.json`: `default_agent` is `build`,
`instructions` loads `shared_instructions.md`, and
`mcp.xx-stack-platform-routing` starts the routing server. Tab primaries
are `build`, `plan`, `research`, `fast-build`, `execution-orchestrator`,
and `parallel-execution-orchestrator`. Slash commands live in
`opencode/command/`. `setup-opencode.sh` installs agents, skills,
commands, and registers the MCP server in `~/.config/opencode/config.json`.

---

## 7. Content packs

### `packs/design`

149 brand design systems, 57 aesthetic skill/design pairs, 31 workflow skills,
plus evals and its own gates. `DESIGN-CATALOG.md` is generated
(`npm run design:catalog`) and in sync.

Gates: `npm run design:golden` (5/5) and `npm run design:html-gate` (67/67, in
CI). Both green.

**This pack is vendored third-party content, not engineering authored here.**
That distinction matters for how you treat it. A byte-level audit found 133 of
148 open-design `design-systems/` files identical to their source at the pinned commit
`e1c277c5`; the "Design System Inspired by Apple" framing in those files is the
source project's, not a description of work done here. Because the pack
redistributes that content, Apache-2.0's requirement to ship the license text
applies:

| Source project | License | Supplies |
|---|---|---|
| `nexu-io/open-design` | Apache-2.0 | 148 of 149 design systems, all 31 workflow skills |
| `bergside/awesome-design-skills` | MIT | all 57 design skills |
| `VoltAgent/awesome-design-md` | MIT | one file (`bmw-m`) |
| op7418 (歸藏) | MIT | `workflow-skills/guizang-ppt/` |

License texts live in `packs/design/licenses/`; per-subtree provenance —
including what could **not** be established — is in
`packs/design/manifest.json`. Open licensing questions are in §11.1.

**The gates over this pack, and the fixes to its content, are ours.**
`design:systems-lint` (§9) parses all 149 systems and found four shipping
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
our 149 design systems name `#000000` as deliberate brand vocabulary, and the
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
| `layout:verify` | component layout, symlinks, executable bits, and every vendored rulebook and license file by name | only the layouts it knows; an unmapped directory is invisible |
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
| `design:systems-lint` | all 149 design systems parse, order their sections, and pair text with surface at AA | accent-on-surface is reported, never failed — 14 sit below 3:1 and those are upstream design choices, not defects |
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

### Every remaining mirror surface is gated

`npm run drift:check` diffs canonical `runtime/{agents,skills}` against the
OpenCode copies. The VS Code / `adapters/` product surface was removed in
1.65.0; those mirrors no longer exist.

Pack content beyond the design pack's own gates remains ungated, which is
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
| `XX_STACK_TOOL_SURFACE` | `routing` keeps five tools; default `full` |
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
| `runtime/platforms.json` | generated registry | no |
| `opencode-orchestration/opencode/platforms.json` | generated registry | no |
| `hermes-orchestration/config/orchestration.json` | `lanes` generated; `execution`/`proxy` hand-tuned | partially |
| `runtime/config.json` | agent registration, permissions | yes |
| `runtime/telemetry.json` | telemetry sink; off by default | yes |
| `runtime/model-rates.json` | cost estimation table | yes |
| `runtime/dangerous-patterns.txt` | exec denylist | yes, with tests |
| `.xxignore` | agent *context* boundary | yes |
| `.gitignore` | what must not be committed | yes |

`.xxignore` and `.gitignore` are different boundaries. `.xxignore` tells agents
what not to sweep into context; `.gitignore` governs commits. A large vendored
or generated surface belongs in both.

---

## 11. Defect register

The 2026-08-02 audit and every follow-up finding live in
[`MANUAL-DEFECTS.md`](MANUAL-DEFECTS.md). That file is the historical record
(how this codebase fails, which gates were green while proving nothing, and
what actually fixed each class). This operating manual no longer inlines it.

All 59 original entries are **fixed**. Open items in that file's §11.1 are
judgment calls (pinning, licensing posture, trademark, contrast on brand
accents), not unfixed defects.

When you add a new confirmed defect, add a row there — not here — and a test
or gate that would have caught it.

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

1. `runtime/skills/<name>/SKILL.md` with the frontmatter contract.
2. Mirror to `opencode-orchestration/opencode/skills/<name>/SKILL.md`, applying
   only the four deliberate deltas.
3. Register in `runtime/SKILLS.md` **and** the OpenCode twin.
4. Add a `packs/rules/coverage.json` entry — an explicit `books: []` if no rule
   book applies. `rules:check` fails without one.
5. `npm run verify`.

### Adding an agent

1. `runtime/agents/<name>.md`, register in `runtime/config.json`.
2. Mirror to the OpenCode tree and register there too.
3. `npm run agents:sync`.
4. Coverage entry, then `npm run verify`.

### Changing hardware

Edit `inventory.json` only. Then `npm run inventory:sync` and
`npm run inventory:check`.

### Changing the exec denylist

Edit `runtime/dangerous-patterns.txt` **and**
`scripts/check-dangerous-patterns.mjs` in the same commit — the script
pins the file's hash, so a pattern change without a test update fails CI. That
coupling is deliberate.

### Iron rules

- `inventory.json` is the only hardware truth.
- Never hand-edit `opencode-orchestration/opencode/agents/*` as if they were
  canonical; edit `runtime/agents/` and mirror.
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

**`drift:check` passes but the OpenCode surface behaves differently.** Unexpected
for bodies the content check covers. Diff the pair by hand, normalizing the
deliberate deltas (`compatibility:`, `model:` pins, path rewrites, nested
`skill:` syntax). Host-specific files listed in `NOT_CONTENT_GATED` are allowed
to differ.

**`drift:check` fails on an agent I just added.** Working as intended. Add the
OpenCode copy under `opencode-orchestration/opencode/agents/` (and register it
in that component's `config.json`) or, if it is canonical-only like `ping`,
add it to `EXPECTED_ONLY` in `check-stack-source-drift.mjs` with a reason.

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
