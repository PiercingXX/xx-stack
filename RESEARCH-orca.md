# Research: orca vs xx-stack

## Section 1: What this repo already has

This section maps overlapping concepts between stablyai/orca and this repository (xx-stack), citing real files and symbols.

### 1.1 Agent definitions and registry

This repo defines **21 agent profiles** in `xx-stack/runtime/config.json` (line 6-357) with mode (primary/subagent), temperature, step limits, tool policies, memory scope, and permissions. Agent instructions live in `xx-stack/runtime/agents/*.md` (21 files including `build.md`, `plan.md`, `execution-orchestrator.md`, `reviewer.md`, etc.). Adapter mirrors exist at `xx-stack/adapters/agents/*.agent.md` (8 files).

Agent precedence rules are documented in `xx-stack/runtime/shared_instructions.md` (lines 71-85): runtime override > repo canonical > adapter mirror > alias.

### 1.2 Skill system

This repo defines **25 canonical skills** in `xx-stack/runtime/skills/<name>/SKILL.md` directories, covering: `audit-security`, `benchmark-performance`, `debug-investigate`, `deploy-ship`, `design`, `design-prototype`, `diagnose-stack`, `ensemble-consensus`, `ideate-product`, `ops-canary`, `ops-deploy-land`, `orchestrate-platform-routing`, `plan-architecture`, `plan-autoreview`, `plan-design`, `plan-feature`, `reflect-retrospective`, `release-doc-sync`, `review-code`, `rewrite-rust-oneshot`, `safety-guardrails`, `setup-observability`, `test-qa`, `train-model-knowledge-injection`, `write-docs`.

Adapter mirrors at `xx-stack/adapters/skills/*.prompt.md` (10 files). Skill precedence documented in `xx-stack/runtime/shared_instructions.md` (lines 87-101) and `xx-stack/runtime/SKILLS.md` (lines 28-40).

### 1.3 MCP server with routing, supervision, task management

The MCP server at `xx-stack/mcp-server/src/index.ts` (line 124-127) registers 4 tool groups:

- **Routing tools** (`routing_tools.ts`): `route_task`, `route_parallel_tasks`, `route_task_with_watchdog` — route tasks to platform tiers/hosts/models based on task description.
- **Supervisor tools** (`supervisor_tools.ts`): session lifecycle, completion validation, abort windows, backoff, recovery keys.
- **Agent tools** (`agent_tools.ts`): agent profile listing, agent memory (get/set/snapshot).
- **Task tools** (`task_tools.ts`): `task_suspend`, `task_resume`, `task_list`, `task_show`, `task_abandon` — persistent task store with status machine.

### 1.4 Platform registry and inventory

`inventory.json` (239 lines) is the single source of truth for hardware, network reachability, and inference runtimes. It fans out to:
- `xx-stack/runtime/platforms.json` — host-agnostic example registry
- `opencode-orchestration/opencode/platforms.json` — live registry
- `hermes-orchestration/config/orchestration.json` — lanes block only

Inventory schema at `inventory.schema.json` defines machines, runtimes (ollama/sglang/llama-cpp/vllm/localai), aggregators (Hermes proxy), and cloud providers.

### 1.5 Hermes orchestration (Python)

`hermes-orchestration/scripts/hermes_orchestrator.py` (1771 lines) is a standalone Python service with:
- Lane definition and health checking (`lane_health` at line 363)
- Priority-sorted lane ordering (`self_hosted_lane_keys`, `cloud_lane_keys` at lines 114-121)
- HTTP proxy server with auth token (`ProxyServer`/`ProxyHandler`)
- Subagent routing with model requirement matching (`resolve_subagent_lane`, `model_matches_requirement`)
- Tool call support probing (`probe_tool_call_support`)
- Capability cache with reuse (`build_inventory_report`)
- JSONL routing logs (`log_routing_event`)
- Command safety (`command_allowed` — tested in `test_orchestrator.py` lines 146-177)

### 1.6 Autonomous loop infrastructure

`xx-stack/runtime/AUTONOMOUS_TODO_LOOP.md` documents the outer-loop runner (`scripts/run-agent-loop.mjs`) with:
- Disk-backed todo and contract state
- Deterministic completion signal parsing (`<promise>DONE</promise>`)
- Retry and stall detection
- Per-iteration logs and resumable state
- Preflight health checks before iteration 1

`xx-stack/runtime/COMPLETION_CONTRACT_TEMPLATE.md` defines the contract structure: objective, scope, acceptance criteria, verification commands, evidence requirements, and a 5-step completion protocol.

### 1.7 Design content pack

`xx-stack/packs/design/` contains 57 design systems and 137 design skills (from upstream nexu-io/open-design, VoltAgent/awesome-design-md, bergside/awesome-design-skills). The `design-engineer` agent (`xx-stack/runtime/config.json` lines 333-345) orchestrates these.

### 1.8 Telemetry and observability

`xx-stack/runtime/TELEMETRY-POLICY.md`, `xx-stack/runtime/telemetry.json`, and MCP observability tools (`observability_tools.ts`) provide optional telemetry disabled by default.

---

## Section 2: Ranked recommendations

### R1: Add a durable Run/Task/Dispatch mailbox system

**Goal:** Replace the current ad-hoc task store (JSON file with lock) with a proper FIFO mailbox delivery system — messages addressed to a Run or Dispatch, crash-safe acknowledgment, and typed lifecycle transitions (worker_done, escalation, question, heartbeat).

**Why it fits this repo specifically:** This repo already has `task_runtime.ts` (task store with status machine), `supervisor_runtime.ts` (session state with event transitions), and routing tools. What's missing is the **message delivery** layer — a coordinator that can dispatch work to a subagent, wait for typed lifecycle messages, acknowledge them, and handle timeout/disconnect recovery. Orca's mailbox system (`check --ack <id> --wait`, `send --to dispatch:<id>`, `ask --question`) is exactly the gap between this repo's current task store and a real multi-agent orchestration system.

**Files to change:**
- `xx-stack/mcp-server/src/task_runtime.ts` — add mailbox delivery table alongside task store
- `xx-stack/mcp-server/src/task_tools.ts` — add `task_send`, `task_check` (with ack/wait), `task_ask`, `task_reply` tools
- `xx-stack/mcp-server/src/supervisor_runtime.ts` — add delivery acknowledgment, consumer generation fencing
- `xx-stack/runtime/shared_instructions.md` — document the mailbox protocol in the delegation section (lines 109-157)

**Acceptance criteria:**
1. Two tasks on the same Run never mix mail.
2. An unacknowledged batch is replayed after server restart.
3. `task_check --wait` returns typed timeout, worker_done, escalation, and question outcomes.
4. A fenced consumer cannot acknowledge or reply.

**Effort:** L (3-5 days) **Risk:** medium — touches the core state machine of the MCP server; needs careful crash-safety design.

---

### R2: Add git worktree-based parallel execution

**Goal:** Allow the `route_parallel_tasks` tool to actually execute subtasks in parallel by creating isolated git worktrees, running agents in them, and collecting results — not just routing recommendations.

**Why it fits this repo specifically:** This repo already has `route_parallel_tasks` (`routing_tools.ts` line 33-55) that produces a *schedule* but does not execute. The `execution-orchestrator` agent (`xx-stack/runtime/config.json` lines 243-267) is designed for plan-exec workflows. Adding worktree-based parallel execution turns routing recommendations into real parallel work. The Hermes orchestrator already has `call_chat` (line 471) that could drive individual worktree agents.

**Files to change:**
- `xx-stack/mcp-server/src/routing_tools.ts` — add `execute_parallel_tasks` tool that creates worktrees and dispatches
- `xx-stack/mcp-server/src/task_runtime.ts` — add `worktreePath` field to task model (already partially there via `worktreePath` in suspend/resume)
- `xx-stack/scripts/` — add worktree creation/cleanup script
- `xx-stack/runtime/agents/execution-orchestrator.md` — document worktree-based parallel execution

**Acceptance criteria:**
1. `execute_parallel_tasks(["fix bug A", "fix bug B"])` creates two worktrees, runs agents, returns results.
2. Worktrees are cleaned up after completion.
3. Failures in one worktree do not affect others.

**Effort:** M (2-3 days) **Risk:** medium — git worktree management is error-prone; needs careful cleanup on failure.

---

### R3: Add typed lifecycle messages (worker_done, escalation, heartbeat) to the supervisor system

**Goal:** Extend the supervisor's session state machine to support typed lifecycle messages from subagents — `worker_done` (with outcome succeeded/failed), `escalation` (with reason), `heartbeat` (with status), and `question` (with options) — with durable storage and typed wait outcomes.

**Why it fits this repo specifically:** The supervisor system (`supervisor_runtime.ts`) already has session events, completion validation, and state transitions. But it treats all subagent outcomes as generic "completion" checks. Adding typed lifecycle messages would let the `execution-orchestrator` agent wait for specific outcomes from sub-subagents, matching Orca's `check --wait --types worker_done,escalation,question` pattern. This repo's `shared_instructions.md` already describes "Accountable Delegation" (lines 109-117) — typed lifecycle messages would make that protocol enforceable rather than advisory.

**Files to change:**
- `xx-stack/mcp-server/src/supervisor_runtime.ts` — add lifecycle message types, durable message store, typed wait
- `xx-stack/mcp-server/src/supervisor_tools.ts` — add `supervisor_send_lifecycle`, `supervisor_wait_lifecycle` tools
- `xx-stack/mcp-server/src/task_tools.ts` — integrate lifecycle messages with task status transitions
- `xx-stack/runtime/shared_instructions.md` — update delegation contract (lines 138-165)

**Acceptance criteria:**
1. A subagent can send `worker_done(succeeded)` and the supervisor records it.
2. A coordinator can `wait_lifecycle(types=["worker_done", "escalation"], timeout=300)` and get the typed result.
3. Duplicate identical completions are idempotent.
4. Stale/foreign lifecycle messages are recorded as history without state mutation.

**Effort:** M (2-3 days) **Risk:** low — builds on existing supervisor state machine; mostly additive.

---

### R4: Add a capability/health cache with reuse for lane probing

**Goal:** Cache lane health, model inventory, and tool-call support results so repeated probes (across multiple routing calls) reuse cached data within a configurable TTL.

**Why it fits this repo specifically:** The Hermes orchestrator already has `build_inventory_report` with `previous` parameter for probe reuse (`test_orchestrator.py` lines 296-304), and a `capability_cache_file` config option. But the MCP server's routing tools (`routing_tools.ts`) call `loadRegistry()` fresh each time and do not cache endpoint health. Adding a capability cache would make `route_task_with_watchdog` (which probes endpoints) practical for repeated use without hammering remote endpoints.

**Files to change:**
- `xx-stack/mcp-server/src/platform_runtime.ts` — add capability cache with TTL, reuse logic
- `xx-stack/mcp-server/src/routing_runtime.ts` — use cache in `routeTask` and `buildWatchdogRouteCandidates`
- `xx-stack/mcp-server/src/routing_tools.ts` — expose cache stats in tool output
- `xx-stack/runtime/config.json` — add `capabilityCache` config section

**Acceptance criteria:**
1. Two `route_task_with_watchdog` calls within TTL reuse the first probe's results.
2. Cache invalidation after TTL expiry triggers a fresh probe.
3. Cache miss on first call works transparently.

**Effort:** S (half day) **Risk:** low — straightforward cache layer; Hermes already has the pattern.

---

### R5: Add a durable mutation ledger (idempotency via request IDs)

**Goal:** Make task creation, dispatch, send, and state transitions idempotent by persisting a request ID → result mapping before executing effects, returning the recorded result on retry.

**Why it fits this repo specifically:** The supervisor system has `makeAttemptId` and `makeRecoveryKey` (`supervisor_runtime.ts`) but no general-purpose idempotency ledger. The task tools (`task_tools.ts`) have `withTaskStoreLock` but no request deduplication. Adding a mutation ledger would prevent double-dispatch when a network timeout hides a successful `task_suspend` or `task_resume` call — a real risk in the MCP stdio transport where timeouts are common.

**Files to change:**
- `xx-stack/mcp-server/src/supervisor_runtime.ts` — add `mutationLedger` table with request ID, payload hash, result, and timestamp
- `xx-stack/mcp-server/src/task_tools.ts` — wrap mutation endpoints with ledger check
- `xx-stack/mcp-server/src/supervisor_tools.ts` — wrap session mutation endpoints with ledger check

**Acceptance criteria:**
1. Two identical `task_suspend` calls with the same request ID return the same result without double-effect.
2. A retry with changed payload returns `request_mismatch`.
3. Ledger entries survive server restart.

**Effort:** M (1-2 days) **Risk:** low — isolated additive change; Orca's Phase 1 checklist already validates this pattern.

---

### R6: Add a CLI for the MCP server (matching orca orchestration commands)

**Goal:** Add a CLI frontend to the MCP server so agents can call routing, task, and supervisor operations via shell commands instead of only MCP tools, enabling use from non-MCP contexts (shell scripts, CI, the Hermes orchestrator).

**Why it fits this repo specifically:** The Hermes orchestrator (`hermes_orchestrator.py`) already has a CLI (`serve`, `health`, `subagent` commands via argparse). The MCP server has no CLI — it only speaks MCP stdio. Adding a CLI would let the Hermes orchestrator call routing decisions directly, and let shell scripts use `xx-stack route-task "implement bug fix"` without an MCP host. Orca's `orca orchestration` command suite is the reference pattern.

**Files to change:**
- `xx-stack/mcp-server/src/cli.ts` — new file, wraps routing/task/supervisor tools as CLI commands
- `xx-stack/mcp-server/package.json` — add `bin` entry
- `hermes-orchestration/scripts/hermes_orchestrator.py` — optionally call CLI instead of duplicating routing logic

**Acceptance criteria:**
1. `xx-stack route-task "fix bug"` prints JSON routing decision.
2. `xx-stack task-create --objective "..."` creates a task and prints its ID.
3. `xx-stack task-list` lists all tasks.
4. All CLI commands accept `--json` for machine-readable output.

**Effort:** M (2-3 days) **Risk:** low — CLI is a thin wrapper over existing MCP tool logic.

---

## Section 3: Explicitly NOT borrowing

### N1: Orca's Electron desktop app with GUI

**Rejected because:** This repo is explicitly headless and local-first — no GUI, no Electron, no desktop app. Orca's entire value proposition is its Electron app with terminal splits, embedded browser, design mode, and native GitHub/Linear integration. Adding any of these would violate the core constraint (`README.md` line 12: "Cloud APIs are off unless you switch them on" — the same principle applies to GUI: it's off unless you opt in). The design pack (`xx-stack/packs/design/`) already provides design systems for those who want to build a UI; the stack itself should not ship one.

### N2: Orca's mobile companion app

**Rejected because:** This repo has no mobile surface, no push notification infrastructure, and no relay server. Adding a mobile companion would require a relay server (violating local-first), an app store presence, and end-to-end encryption infrastructure. The repo's telemetry policy (`xx-stack/runtime/TELEMETRY-POLICY.md`) is "optional and disabled by default" — a mobile companion is the opposite of that philosophy. This repo's monitoring surface is the MCP server's observability tools and the Hermes routing log (`logs/routing.jsonl`), which are sufficient for headless operation.

### N3: Orca's per-agent account management (Claude accounts, Codex accounts, Gemini accounts, etc.)

**Rejected because:** This repo's model selection is host-agnostic (`xx-stack/runtime/shared_instructions.md` line 19: "Use the current host or caller model by default"). It does not manage API keys, accounts, rate limits, or billing for multiple AI providers. The inventory system (`inventory.json`) describes machines and runtimes, not accounts. Adding account management would pull in a huge surface (OAuth flows, token storage, rate-limit tracking, usage dashboards) that is orthogonal to this repo's purpose: routing work across machines you own.

### N4: Orca's SSH/WSL remote execution and relay infrastructure

**Rejected because:** This repo already has a simpler model for remote execution: Tailscale-based direct connections defined in `inventory.json` (network scope "tailscale"). The Hermes orchestrator reaches remote machines over Tailscale MagicDNS. Adding SSH key management, WSL distro detection, relay servers, and connection multiplexing would duplicate what Tailscale already provides. The `xx-stack/scripts/scan-tailscale.mjs` script already discovers machines on the tailnet — that is the right level of abstraction for this repo.

### N5: Orca's computer-use / browser automation features

**Rejected because:** This repo is an agent orchestration and routing control plane, not an agent itself. Computer-use (browser control, desktop UI interaction, screenshot capture) belongs in the agent layer, not the orchestration layer. The `design-engineer` agent could theoretically use browser automation for design prototyping, but that would be a skill-level concern, not a stack-level primitive. Adding it here would blur the boundary between the control plane and the agents it routes.

---

## Section 4: Evidence discipline

### Upstream claims from stablyai/orca

| Claim | Tag |
|---|---|
| Orca is an Electron desktop app for macOS, Windows, Linux | [read their code] — `package.json` electron-vite config, `src/main/index.ts`, `src/renderer/` |
| Orca has a mobile companion app (iOS + Android) | [from their docs] — `README.md` lines 35-39 mention App Store, TestFlight, Android APK |
| Orca supports parallel worktrees (one prompt → five agents) | [from their docs] — `README.md` lines 49-51 |
| Orca has a terminal with WebGL rendering and infinite splits | [from their docs] — `README.md` lines 63-65 |
| Orca has design mode (click UI → agent prompt) | [from their docs] — `README.md` lines 77-79 |
| Orca has native GitHub and Linear integration | [from their docs] — `README.md` lines 91-93; [read their code] — `src/main/github/`, `src/main/linear/` directories exist |
| Orca has a CLI (`orca` binary) | [read their code] — `package.json` line 8: `"orca": "./out/cli/index.js"` |
| Orca has an orchestration skill with Run/Task/Dispatch/mailbox primitives | [read their code] — `skill-guides/orchestration.md` (389 lines), `skills/orchestration/SKILL.md`, `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` (1788 lines) |
| Orca's orchestration has FIFO mailbox with crash-safe acknowledgment | [read their code] — `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` lines 121-134 |
| Orca's orchestration has typed lifecycle messages (worker_done, escalation, heartbeat, question) | [read their code] — `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` lines 136-147, `skill-guides/orchestration.md` lines 128-150 |
| Orca's orchestration has durable mutation ledger with request ID deduplication | [read their code] — `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` lines 169-178 |
| Orca's orchestration has pane authority (unforgeable per-Dispatch capability) | [read their code] — `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` lines 159-167 |
| Orca supports multi-server federation (connected Orca servers) | [read their code] — `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` lines 286-299 |
| Orca supports SSH and WSL remote execution | [read their code] — `src/main/ssh/`, `src/main/wsl.ts` directories exist |
| Orca has account management for Claude, Codex, Gemini, Grok, etc. | [read their code] — `src/main/claude-accounts/`, `src/main/codex-accounts/`, `src/main/gemini/`, `src/main/grok-accounts/` directories exist |
| Orca has computer-use / browser automation | [read their code] — `skills/computer-use/` directory exists, `skill-guides/computer-use.md` |
| Orca has agent detection and session management | [read their code] — `src/shared/agent-detection.ts`, `src/shared/agent-session-option-catalog.ts` exist |
| Orca uses SQLite for durable storage | [read their code] — `src/main/sqlite/` directory exists |
| Orca has end-to-end encryption for mobile relay | [read their code] — `src/shared/mobile-e2ee-v2-contract.ts`, `src/shared/mobile-e2ee-v2-framing.ts` exist |

### Claims from this repo (xx-stack)

All claims in Sections 1-3 are backed by direct file reads performed during this analysis. Every path:line reference was verified by reading the file.