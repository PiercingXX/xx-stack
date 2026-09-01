# Repository Layers

xx-stack is organized as two logical layers.

This split is physically active for the design pack. Canonical pack paths live under `packs/design/`, with root-level compatibility symlinks retained for existing references.

## Layer 1: Stack Core

Stack core is the reusable agent and skill runtime.

It includes:

- canonical agent and skill definitions
- MCP tooling and routing infrastructure
- eval harnesses for stack behavior
- setup scripts, hooks, ignore rules, and runtime docs

Current root-level paths that belong to stack core:

- `runtime/`
- `mcp-server/`
- `evals/`
- `scripts/`
- `setup-opencode.sh`
- `hooks/`
- `.xxignore`
- `README.md`
- `LICENSE`

## Layer 2: Content Packs

Content packs are domain payloads consumed by agents and skills, but they are not the runtime itself.

The current repo has two content packs: design and rules.

The design pack includes:

- design systems and visual references
- aesthetic style libraries
- generated catalogs derived from those libraries
- design-specific workflow assets and templates
- design-specific eval fixtures and gates
- `manifest.json` recording per-subtree provenance and license, with an
  explicit `verified` / `asserted` / `unknown` marker on each entry
- `licenses/` holding the verbatim upstream license texts the vendored
  material is redistributed under, plus the per-skill
  `workflow-skills/guizang-ppt/LICENSE` that upstream itself carves out

The rules pack (`packs/rules/`) includes:

- 11 vendored engineering rule books, each in context-tiered sizes
- `manifest.json` describing every book and its default tier
- `coverage.json` mapping each skill and agent to the books that apply, with
  `books: []` as an explicit "no book changes this decision" decision
- `LICENSE` covering the vendored material
- a CI gate, `npm run rules:check`, which fails when a skill or agent has no
  coverage entry

Canonical design content-pack paths:

- `packs/design/design-systems/`
- `packs/design/design-skills/`
- `packs/design/DESIGN-CATALOG.md`
- `packs/design/workflow-skills/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`

Compatibility symlinks retained at root:

- `design-systems/` -> `packs/design/design-systems/`
- `design-skills/` -> `packs/design/design-skills/`
- `DESIGN-CATALOG.md` -> `packs/design/DESIGN-CATALOG.md`

## Migration Rules

When moving files or behavior between layers:

1. Keep install and runtime entry points stable.
2. Move content payloads before moving runtime contracts.
3. Update generators and eval scripts to resolve pack paths explicitly.
4. Preserve canonical paths or provide a compatibility shim.
5. Update README and setup docs in the same change as any filesystem move.

## Short-Term Policy

During transition:

- use `packs/design/*` as canonical paths in docs and scripts
- keep compatibility shims until downstream consumers no longer depend on legacy paths
- avoid describing the full repo as only runtime infrastructure
- document whether new material belongs to stack core or to the design pack