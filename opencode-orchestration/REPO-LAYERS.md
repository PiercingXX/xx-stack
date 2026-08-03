# Repository Layers

This repo has two real layers:

1. stack core
2. content packs

That split matters because the runtime is private and operational, while the content packs are payloads consumed by that runtime.

The current repo is optimized for one user's OpenCode setup, local self-hosted inference, and Tailscale-distributed hosts.
It is not organized for public packaging first.

## Layer 1: Stack Core

Stack core is the reusable runtime and orchestration layer.

It includes:

- canonical OpenCode agent and skill surfaces
- VS Code mirror surfaces
- MCP tooling and routing infrastructure
- setup and registry sync automation
- reliability, supervisor, and watchdog machinery
- runtime docs and install surfaces

Current root-level paths that belong to stack core:

- `opencode/`
- `vscode/`
- `mcp-server/`
- `evals/`
- `scripts/`
- `setup.sh`
- `setup-opencode.sh`
- `setup-vscode.sh`
- `hooks/`
- `.xxignore`
- `README.md`
- `REPO-LAYERS.md`
- `MAINTAINER-RUNBOOK.md`
- `LICENSE`

If a change affects local-vs-remote routing, OpenCode install behavior, platform registry sync, watchdog behavior, or runtime policy, it belongs to stack core.

## Layer 2: Content Packs

Content packs are domain payloads used by agents and skills, but they are not the runtime itself.

The current repo has two content packs: design and rules. Both reach this
component through the `packs/` symlink to `../xx-stack/packs`, so they are one
copy shared with the core component, not a second set.

The design pack includes:

- brand design systems
- style libraries
- generated catalogs derived from those libraries
- design workflow assets and templates
- design-specific eval fixtures and gates

Canonical design content-pack paths:

- `packs/design/design-systems/`
- `packs/design/design-skills/`
- `packs/design/DESIGN-CATALOG.md`
- `packs/design/workflow-skills/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`

If a change affects design systems, design prompts, design examples, or design eval fixtures, it belongs to the design pack.

The rules pack includes:

- 11 vendored engineering rule books, each in context-tiered sizes
- `packs/rules/manifest.json` describing every book and its default tier
- `packs/rules/coverage.json` mapping each skill and agent to the books that
  apply, with `books: []` as an explicit "no book changes this decision" decision
- `packs/rules/LICENSE` covering the vendored material
- a CI gate, `npm run rules:check`, which fails when a skill or agent has no
  coverage entry

If a change affects rule-book content, tiers, or which entries cite which books, it belongs to the rules pack.

## Canonical Surfaces

Edit these when making real source changes.

### Stack core canonical sources

- `opencode/`
- `vscode/`
- `mcp-server/src/`
- `scripts/`
- `setup.sh`
- `setup-opencode.sh`
- `setup-vscode.sh`
- `README.md`
- `REPO-LAYERS.md`
- `MAINTAINER-RUNBOOK.md`

### Design pack canonical sources

- `packs/design/design-systems/`
- `packs/design/design-skills/`
- `packs/design/workflow-skills/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`

## Generated Surfaces

These are generated or regenerated from source and should not become the hidden source of truth.

- `packs/design/DESIGN-CATALOG.md` is generated from the design pack catalog script
- generated eval outputs and temporary quality gate artifacts are derived data
- `mcp-server/dist/` is build output and should not be treated as a source of truth

If a generated file looks wrong, fix the source or generator first.

## Vendored Or Upstream-Derived Surfaces

Some of the stack content originated outside this repo, especially from the broader `xx-stack` work.

In this repo, once that content is landed under canonical paths, it should be treated as maintained source here unless there is an explicit sync process that says otherwise.

Practical rule:

1. do not assume upstream will overwrite local changes automatically
2. do not edit historical or compatibility copies when a canonical in-repo path exists
3. if a future sync from upstream is needed, do it deliberately and document it in the same change

## Compatibility-Only Surfaces

These exist to keep older references or runtime assumptions working.
They are not the preferred authoring targets.

- `.opencode/` when it exists as a compatibility path for runtime discovery
- root compatibility symlinks such as `design-systems/`, `design-skills/`, and `DESIGN-CATALOG.md`
- wrapper paths such as `opencode/skills/design/` and `evals/golden-tasks/` that point at the design pack

Do not add new work to compatibility surfaces unless the runtime still requires them.

## Maintainer Rule Of Thumb

When deciding where to edit:

1. if it changes runtime behavior, edit stack core
2. if it changes design payloads, edit the design pack
3. if it is generated, change the generator or source
4. if it is compatibility-only, prefer the canonical source instead

## Private Runtime Context

The stack core should be described from the real deployment model:

1. local workstation first
2. Tailscale-distributed self-hosted hosts second
3. cloud strictly opt-in (never used as an implicit fallback)

That should guide documentation, naming cleanups, and future refactors.

## Current Layout

The physical split for the design content pack is already active:

```text
opencode/
vscode/
mcp-server/
evals/
scripts/
hooks/
.xxignore
README.md
REPO-LAYERS.md

packs/
  design/
    design-systems/
    design-skills/
    DESIGN-CATALOG.md
    opencode/
      skills/
        design/
    evals/
      golden-tasks/
    scripts/
      generate-design-catalog.mjs
      evaluate-golden-tasks.mjs
      quality-gate-html.mjs
```

Compatibility shims still exist for older references, but `packs/design/*` is the canonical path family for the design pack.

## Validation Baseline

After meaningful stack-core changes, run at least:

```bash
bash -n setup.sh
bash -n setup-opencode.sh
bash -n setup-vscode.sh
bash -n scripts/lib/setup-config-helpers.sh
bash -n scripts/lib/setup-endpoint-helpers.sh
bash -n scripts/lib/setup-hardware-helpers.sh
bash -n scripts/lib/setup-model-helpers.sh
bash -n scripts/lib/setup-registry-helpers.sh
bash -n scripts/lib/setup-skill-helpers.sh
bash -n scripts/lib/setup-tailscale-helpers.sh
cd mcp-server && npm test && npm run design-pack:verify-layout && npm run harness:ci
```

If a change touches only the design pack, run the smallest relevant subset plus any affected design-pack generators or evals.

## Short-Term Policy

Until the cleanup roadmap is further along:

- use `packs/design/*` as canonical in docs and scripts
- keep compatibility shims only where the private runtime still depends on them
- avoid describing the repo as public-packaging infrastructure
- document whether a change belongs to stack core or the design pack in the same PR or commit series