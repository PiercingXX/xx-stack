# Cloud Escalation Policy

Purpose
- Keep the system local-first and use cloud only as explicit last resort.

## Default behavior

- A cloud lane is *configured* in `config/orchestration.json`, but cloud use is
  off by default and the default fails closed: it turns on only when
  `policy.require_manual_cloud_escalation` is `false`,
  `policy.cloud_enabled_by_default` is `true` **and**
  `execution.subagents_allow_cloud_default` is `true`. A missing key means off.
- Cloud can be selected for delegated subagents when the active routing preset allows it
  and `--allow-cloud` was passed (or the three keys above are all set).
- Primary task cloud use still requires explicit `--allow-cloud`.
- Decisions are made on the orchestrator host after self-hosted lane checks.

## Gate conditions (all required)

Escalate only if every condition is true:

1. Local decision-first: the control plane attempted self-hosted-first resolution.
2. Hardware limit or specialized model need: the sglang and ollama lanes on `example-gpu-box` cannot satisfy profile constraints or required model availability.
3. Decomposition exhausted for constrained workloads, or the active specialized preset explicitly requires cloud.
4. Manual approval for primary task cloud use, or eligible delegated subagent profile for cloud delegation.

If any condition is false, cloud is denied.

## Delegation order

1. `example-gpu-box-sglang` over Tailscale (preferred delegated lane, batched GPU serving)
2. `example-gpu-box-ollama` over Tailscale (fallback runtime on the same box)
3. Cloud lane for eligible delegated tasks only after self-hosted exhaustion or model mismatch

## Specialized-model rule

- Use `--required-model` to require a model substring for delegated selection.
- If neither the sglang nor ollama lane matches that requirement, cloud becomes eligible as the next lane.
- If a matching self-hosted lane exists, cloud is not used.

## Lane-offline rule

- If the sglang lane is down, route delegated work to the ollama lane in the same run.
- A single-lane outage alone is not enough to justify cloud; only full self-hosted exhaustion is.

## Cloud model policy

- Model pool: premium GitHub-hosted models available through the local `hermes` CLI.
- Preferred default when approved: `gpt-5.3-codex` (`lanes.cloud.model`).
- Cloud fallback model #2: `gpt-5.4` (`lanes.cloud.fallback_models`).

## Required escalation telemetry

When cloud is selected, append JSONL event to `logs/cloud-escalations.jsonl` with:

- `timestamp`
- `task_id`
- `reason_code`
- `selected_model`
- `decomposition_attempted`
- `local_capacity_snapshot`
- `remote_capacity_snapshot`
- `escalation_approved_by`

## Reason code set

- `CONTEXT_TOO_LARGE_LOCAL`
- `VRAM_RESIDENCY_FAIL_LOCAL`
- `VRAM_RESIDENCY_FAIL_REMOTE`
- `CONCURRENCY_SLO_MISS`
- `LATENCY_SLO_MISS`
- `NON_DECOMPOSABLE_WORKLOAD`
- `COMPATIBILITY_BLOCKER_LOCAL`
- `MANUAL_RUN`

## Post-cloud return-to-local rule

- Next task starts with local-first routing again.
- Cloud route is non-sticky by policy.