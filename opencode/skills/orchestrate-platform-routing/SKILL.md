---
name: orchestrate-platform-routing
description: Build a task-to-platform delegation plan using the editable platform registry, current model inventory, and cost/privacy constraints.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Orchestrate Platform Routing

## Purpose
Turn a user task or project plan into an explicit delegation map across primary self-hosted lanes, local fallback runtimes, and cloud providers.

Prefer live runtime state before repo defaults.

Registry resolution order:

1. attached live registry provided with the task
2. `~/.config/opencode/xx-stack-platforms.json` when accessible
3. `.opencode/platforms.json` as repo fallback

Do not invent alternate registry paths.

## Use When
- You need to decide which platform should handle a task before execution starts.
- You are breaking a multi-step project into subagent slices.
- Model availability, hardware limits, privacy, latency, or cost matter.

## Activation Contract

Use this skill only for routing and delegation decisions.

Do not use it for direct implementation, direct review, or deterministic repo inspection that does not require host/model selection.

## Required Inputs
- User request, feature spec, or execution plan
- Any hard constraints: privacy, latency, budget, availability, provider lock-in
- Current platform registry state from `.opencode/platforms.json`

## Workflow

1. Load platform inventory
- Read primary, local fallback, overflow fallback, compatibility, and cloud tiers from the selected registry.
- Confirm host reachability and recent model sync data if present.
- If live and fallback registries disagree, prefer live runtime state and call out the mismatch.

2. Classify the work
- Split the request into slices such as planning, implementation, review, QA, release, research, or training.
- Mark which slices are latency-sensitive, privacy-sensitive, or quality-sensitive.

3. Choose the best tier per slice
- Prefer the primary execution lane for implementation, review, planning, orchestration, and standard coding tasks.
- Prefer the reasoning lane for architecture, long-context synthesis, and heavier research or delegated reasoning.
- Prefer the local fallback lane for quick verification, offline edits, or when the primary hosts are unavailable.
- Prefer overflow fallback only as an operational fallback.
- Prefer cloud only when it adds required capability, resilience, or quality that self-hosted tiers cannot supply.
- If multiple slices target the same host with different models, schedule them sequentially unless the host is explicitly marked safe for concurrent multi-model use.

4. Define fallback order
- For each slice, specify the next acceptable tier if the preferred tier is unavailable.
- Note why the fallback is acceptable.

5. Classify degradation behavior
- Distinguish critical slices from optional slices.
- For each optional slice, state what is lost if it is skipped.
- For each critical slice, state whether work blocks entirely or can be replanned.

6. Define host execution safety
- Mark slices that need exclusive host/model access.
- Use every reachable preferred or fallback host before stacking additional queued waves on a single endpoint.
- Respect host `executionPolicy` limits (`maxParallelSlices`, `maxConcurrentModels`, `contextReservePercent`) when declaring parallel-safe slices.
- Do not label slices parallel-safe when they would force model switching on the same catalog-backed endpoint and the host policy does not allow it.

7. Produce a delegation map
- Assign each slice to a platform host and model.
- Include the reason, trade-offs, and any operational risk.

## Failure Taxonomy

If routing cannot be satisfied, classify the blocker:

- `TRANSIENT`: host reachable state is unstable, timeout, temporary sync mismatch
- `ENVIRONMENT`: endpoint denied, host offline, registry unreadable
- `CAPABILITY`: no model on any tier can satisfy the slice
- `DETERMINISTIC`: invented path, invalid model name, contradictory routing request

Recovery policy:

- `TRANSIENT`: retry reachability reasoning once, then use the declared fallback
- `ENVIRONMENT`: degrade to the next real registry or host and state the limitation
- `CAPABILITY`: reduce scope or escalate to cloud only with an explicit reason
- `DETERMINISTIC`: fix the routing assumptions before continuing

## Verification States

- `PASS`: routing uses observed hosts/models and valid fallbacks
- `FAIL`: one or more critical slices cannot be assigned to a real route
- `AMBIGUOUS`: registry exists but freshness, reachability, or model suitability is uncertain

## Output

Provide this exact structure:

# Platform Delegation Plan

## Constraints
- [constraint]

## Inventory Summary
- [tier] -> [host] -> [models of interest]

## Slice Routing
1. [slice name] -> [tier/host/model]
- Why this choice
- Fallback if unavailable
- Criticality: critical / optional
- If skipped: [what degrades]
- Risks or limits
- Host execution rule: exclusive-on-host / safe-parallel

## Escalation Rules
- [condition] -> [escalation path]

## Final Recommendation
- Primary execution path
- When to override it