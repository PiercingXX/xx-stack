# Maintainer Runbook

This is the single control-plane document for operating this private OpenCode stack.

Use this file first when the runtime is unhealthy.
Use [opencode/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md](opencode/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md) only for the strict supervised-completion loop after the broader runtime is already understood.

## Control Plane

- Stack config: `opencode/config.json`
- Platform registry: `opencode/platforms.json`
- Runtime sync entrypoint: `scripts/sync-runtime-config.js`
- Setup coordinator: `setup.sh`
- MCP server and tests: `mcp-server/`

## Fast Verification

Run these before chasing deeper failure modes:

```bash
bash -n setup.sh
bash -n setup-opencode.sh

cd mcp-server && npm test
cd mcp-server && npm run design-pack:verify-layout
cd mcp-server && npm run harness:ci
```

If one of these fails, fix that surface before assuming the router or supervisor is wrong.

The shell-syntax, JSON-validity, `npm test`, and repo-layout checks also run automatically in CI (`../.github/workflows/ci.yml`) on every push and pull request.

## Failure Modes

### Host Unreachable

Symptoms:

- remote Tailscale hosts stop receiving delegated work
- routing falls back to local unexpectedly
- setup or sync logs show a host as unreachable

Checks:

```bash
rg -n '"reachable"|"endpoint"|"provider"' opencode/platforms.json
./setup.sh
```

Recovery:

1. Confirm the affected host still exists in `opencode/platforms.json` and is enabled.
2. Confirm the host endpoint and network scope still match the real Tailscale lane.
3. Re-run `./setup.sh` if discovery or registry persistence is stale.
4. Re-run `cd mcp-server && npm test` after sync so routing assumptions are checked against the updated registry.

### Model Mismatch

Symptoms:

- an agent selects a provider/model pair that is no longer present on the chosen host
- runtime sync keeps stale provider models after hardware or host changes
- a task routes correctly but fails on model availability

Checks:

```bash
rg -n 'model' opencode/config.json opencode/platforms.json
./setup.sh
```

Recovery:

1. Treat `opencode/platforms.json` as the live inventory source and `opencode/config.json` as the synced consumer.
2. Re-run runtime sync after inventory changes.
3. If the desired remote model is gone, allow the synced fallback to local or another reachable Tailscale host instead of pinning the stale model back in.

### Unexpected Remote Routing

Symptoms:

- coding work leaves the local workstation without a clear reason
- controller agents stop preferring the local lane
- delegated work lands on the wrong Tailscale tier

Checks:

```bash
cd mcp-server && npm test
cd mcp-server && npm run harness:ci
```

Recovery:

1. Verify that the registry still marks the local host reachable and enabled.
2. Verify that runtime sync did not preserve a stale remote assignment after a reachability change.
3. Inspect recent edits in `scripts/sync-runtime-config.js`, `scripts/lib/runtime-config-sync-policy.js`, and `mcp-server/src/routing_selection_runtime.ts` together before changing any one file in isolation.

### Watchdog Or Recovery Loops

Symptoms:

- sessions bounce between `running`, `cooldown`, and recovery without converging
- completion attempts fail with stale evidence or missing judge output
- continuation prompts repeat without new work landing

Checks:

```bash
cd mcp-server && npm test
cd mcp-server && npm run harness:ci
```

Recovery:

1. Follow the strict completion sequence in [opencode/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md](opencode/SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md).
2. Reproduce the failure with deterministic verification before changing reliability thresholds.
3. Treat stale evidence, memory drift, and judge failures as blocking signals, not noise.
4. Only tune watchdog thresholds after the regression suite is green.

## Change Discipline

When a fix touches routing or reliability behavior:

1. Patch the smallest owning surface.
2. Add or update deterministic regression coverage in `mcp-server/src/reliability.test.ts` when the failure mode is policy- or recovery-related.
3. Re-run the full validation baseline before calling the cleanup complete again.

Agent metadata (model, temperature, steps, permissions, descriptions) is canonical in
`opencode/config.json`. The `opencode/agents/*.md` files
are mirrors for prompt content and discovery; when you change an agent's model or
description, update `opencode/config.json` first and sync the mirrors to match.