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
- Config file: `.xx-stack/telemetry.json`
- Default: disabled (`"enabled": false`)
- Helper hooks: not shipped by default; if you add one locally, keep it minimal and local-first

## Skills With Optional Telemetry Snippets
- `review-code`
- `test-qa`
- `benchmark-performance`
- `ops-canary`
- Internal workflow helpers are not part of the public skill surface and should not be listed separately here.
