# Telemetry Policy

## Decision
Telemetry is optional and disabled by default for skill execution workflows.

## Keep Telemetry Only When It Adds Automation Value
Use telemetry when it directly supports one or more of these:
- Evaluation trending across runs
- Regression detection for workflow quality
- Runtime reliability monitoring for agent/skill pipelines

If a telemetry event does not support measurable automation outcomes, remove it.

## Implementation Rules
1. Default off
- No mandatory prompts or forced enrollment in skill workflows.

2. Explicit opt-in
- Enable only through explicit configuration.

3. Local-first
- Prefer local files for metrics storage where possible.

4. Minimal fields
- Capture only data needed for automation metrics.
- Avoid content payloads, source code, and sensitive identifiers.

5. Clear lifecycle
- Define retention and cleanup policy for telemetry files.

## Current Migration Guidance
- Imported Wave 1 skills include no telemetry hooks.
- Telemetry can be added later to specific ops/eval skills if automation reporting requires it.

## Current Implementation
- Config file: `runtime/telemetry.json`
- Default: disabled (`"enabled": false`)
- Helper hooks: not shipped by default; if you add one locally, keep it minimal and local-first

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string | yes | ISO-8601 timestamp |
| `skill` | string | yes | Skill or operation name |
| `outcome` | string | yes | One of: success, failure, error, timeout, cancelled |
| `durationMs` | number | yes | Wall-clock duration in milliseconds |
| `lane` | string | no | Routing lane label (e.g. local, cloud, tailscale-ollama) |
| `tokensIn` | number | no | Input tokens consumed |
| `tokensOut` | number | no | Output tokens generated |
| `costUsd` | number \| null | no | Estimated or explicit cost in USD |
| `model` | string | no | Model name used for cost estimation |

## Cost Estimation

Cost is computed from `model-rates.json` when `tokensIn` and/or `tokensOut` are provided and no explicit `costUsd` override is given.

- **Known models**: cost is computed as `(tokensIn / 1000) * costPer1kInputTokens + (tokensOut / 1000) * costPer1kOutputTokens`.
- **Unknown models**: `costUsd` is recorded as `null` (never zero) to distinguish "no cost data" from "zero cost".
- **Local lanes** (ollama/*, sglang/*, vllm/*): rates are zero, so `costUsd` is zero — these models run locally at no API cost.
- **Explicit override**: passing `costUsd` directly skips estimation entirely.

The response from `record_telemetry` includes a `costSource` field with one of:
- `"explicit"` — caller provided `costUsd` directly
- `"estimated"` — computed from model-rates.json
- `"unknown-model"` — no rate found, cost is null

This is an **estimate**, not a bill. Actual API charges depend on provider pricing, caching, and rounding policies.

## Skills With Optional Telemetry Snippets
- `review-code`
- `test-qa`
- `benchmark-performance`
- `ops-canary`
- Internal workflow helpers are not part of the public skill surface and should not be listed separately here.
