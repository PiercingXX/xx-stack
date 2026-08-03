# craft/ in xx-stack — what applies here and what does not

**This file is authored in xx-stack. Every other file in `craft/` is vendored
byte-for-byte from `nexu-io/open-design`** (see `../manifest.json`, subtree
`craft/`). The vendored files are never edited, because byte-comparability
against upstream is the only way to tell our changes from upstream drift.

`README.md` in this directory is therefore upstream's README, unmodified, and it
describes upstream's runtime. This file records where that description does not
match this repository, so a reader does not have to guess.

## What is the same

- **The four-axis model.** `design-systems/` says what a brand looks like,
  `design-skills/` supplies aesthetic direction, `workflow-skills/` says how to
  build one artifact type, and `craft/` supplies the universal rules that apply
  regardless of brand. That is a genuinely new axis for this pack.
- **The opt-in.** A skill declares its craft dependencies in its `od:`
  frontmatter block, and only those files are worth paying context tokens for:

  ```yaml
  od:
    craft:
      requires: [typography, color, anti-ai-slop]
  ```

  Our 31 `workflow-skills/*/SKILL.md` already carry upstream's `od:` block, so
  the binding is upstream's convention, not one invented here.
- **The forward-reference contract.** A slug named by a skill must resolve to
  `craft/<slug>.md` or be listed in `FUTURE_SECTIONS.md`. A typo must not
  silently drop a section.
- **The severity vocabulary.** `anti-ai-slop.md` speaks P0/P1/P2, which is
  already the vocabulary of every `workflow-skills/*/references/checklist.md`
  in this pack.

## What is different

| Upstream README says | Here |
|---|---|
| `pnpm lint:craft` / `pnpm guard` enforce slug resolution | `scripts/check-craft-references.mjs` does. Same contract, no pnpm monorepo. |
| A daemon prompt-composer injects the requested sections above the skill body | Nothing injects anything. Selection is a **budget decision the agent makes**, the same position `packs/rules` takes with its nano/mini/full tiers — the server does not perform it. |
| `apps/daemon/src/lint-artifact.ts` auto-checks the P0 list in `anti-ai-slop.md` | `scripts/quality-gate-html.mjs` does, driven by `anti-ai-slop-rules.json` in this directory. That file is the rule table as **data**; the script is a generic engine. See the licensing note below. |
| Rules reference `.ph-img`, `data-od-id`, and other seed/app affordances | `data-od-id` is an upstream desktop-app comment-mode anchor and is **not** checked here — we have no comment mode. It is left in the prose as upstream wrote it. |
| `skills/`, `design-templates/`, `design-systems/` axis names | Ours are `design-skills/`, `workflow-skills/`, `design-systems/`. The craft prose does not depend on those paths. |

## Which skills opt in

Twelve of our 31 workflow skills carry `od.craft.requires`, taken from
upstream's own bindings for those slugs rather than invented here:

| Skill | requires |
|---|---|
| `blog-post`, `digital-eguide`, `docs-page` | typography, typography-hierarchy, typography-hierarchy-editorial, rtl-and-bidi |
| `dashboard` | state-coverage, accessibility-baseline, laws-of-ux |
| `finance-report` | rtl-and-bidi |
| `gamified-app`, `mobile-app` | state-coverage, animation-discipline |
| `hr-onboarding` | accessibility-baseline |
| `kanban-board` | state-coverage, laws-of-ux |
| `mobile-onboarding` | state-coverage, animation-discipline, accessibility-baseline, form-validation, laws-of-ux |
| `pricing-page` | laws-of-ux |
| `saas-landing` | typography, color, anti-ai-slop, laws-of-ux |

The other 19 have no upstream binding. They are left unbound deliberately —
absence is a decision here, the same way `packs/rules/coverage.json` records
explicit empty entries. Add one only when upstream does, or with a reason.

Resolve a slug with:

```bash
node xx-stack/packs/design/scripts/check-craft-references.mjs
```

## Licensing

Two hops, both verified by reading the upstream LICENSE files:

1. `referodesign/refero_skill` — MIT, © 2026 Refero
   (`../licenses/referodesign-refero_skill-MIT.txt`). Upstream attributes
   `craft/` as adapted from it; three files (`typography.md`, `color.md`,
   `anti-ai-slop.md`) carry that attribution inline.
2. `nexu-io/open-design` — Apache-2.0
   (`../licenses/nexu-io-open-design-Apache-2.0.txt`). The adaptation and the
   other eight rulebooks are upstream's own work.

`anti-ai-slop-rules.json` encodes rule *values* (hex lists, emoji list, phrase
patterns, thresholds) as data. No upstream code was ported —
`scripts/quality-gate-html.mjs` stays MIT and generic, which is why the rule
table is data rather than a transliterated `lint-artifact.ts`.

That file draws on a **third** upstream, and is the only file here that does:

3. `google-labs-code/stitch-skills` — Apache-2.0
   (`../licenses/google-labs-code-stitch-skills-Apache-2.0.txt`), from
   `plugins/stitch-utilities/skills/taste-design/SKILL.md`. Seven of the 18
   rules come from it, plus three extra invented-metric phrasings. Its design
   guidance is self-contained prose — the hosted Stitch service it mentions is
   for its own authoring workflow, which was not taken.

Every rule carries a `source` field, and the file's `notAdopted` list records
fifteen upstream rules that were deliberately refused with the reason for each
— including one point on which the two upstreams flatly disagree
(`picsum.photos` as a placeholder host: recommended by one, banned by the
other; banned here).
