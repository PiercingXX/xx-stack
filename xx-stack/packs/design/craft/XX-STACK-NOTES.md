# craft/ in xx-stack — what applies here and what does not

**This file is authored in xx-stack.** So are `anti-ai-slop-rules.json` and
`design-intent.md`. **Every other file in `craft/` is vendored byte-for-byte
from `nexu-io/open-design`** (see `../manifest.json`, subtree `craft/`). The
vendored files are never edited, because byte-comparability against upstream is
the only way to tell our changes from upstream drift.

Three kinds of file live here, and conflating them is the mistake this note
exists to prevent:

| Kind | Files | Rule |
|---|---|---|
| Vendored | the 11 rulebooks + `README.md` + `FUTURE_SECTIONS.md` | never edit; byte-identical to `dceac12` |
| Authored here, from upstream material we hold | `anti-ai-slop-rules.json`, this file | ours; rule *values* attributed per-entry |
| Authored here, from ideas we did **not** take | `design-intent.md` | ours; nothing to byte-compare, nothing to sync |

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

`design-intent.md` is a **twelfth** shipped section and is bound to **no**
skill, on purpose. Every binding in the table above is upstream's at `dceac12`,
transcribed unchanged; upstream has no binding for a file it does not have, and
inventing one would break exactly the provenance rule that makes the table
trustworthy. It still resolves as an `od.craft.requires` slug, so a skill can
opt in later without a code change. `check-craft-references.mjs` therefore
reports `craft sections shipped: 12` and names `design-intent` under "shipped
but required by no skill" — a NOTE, not a failure, and the expected steady
state.

Resolve a slug with:

```bash
node xx-stack/packs/design/scripts/check-craft-references.mjs
```

## `design-intent.md` — doctrine, not a rulebook

The 11 vendored rulebooks say how to render something once you know what you are
building. `design-intent.md` is about the step before: how the thing gets
described. It is authored here from three arguments in
`google-labs-code/design.md`'s `PHILOSOPHY.md` (Apache-2.0, read at `9bf8eae`),
restated in our own words — no upstream sentence is reproduced and no upstream
file is redistributed.

It ships no checkable rule and no gate reads it. It is filed under `craft/` for
one reason: it is the **theory** behind `anti-ai-slop-rules.json`, which encodes
18 mechanically checkable rules and has never stated why any of them exist.

One of its three arguments **argues against work this repo has queued**. Upstream
holds that token values are context and not rendering instructions, which is the
premise of `UPSTREAM-BORROW-TODO.md` task 33 (vendor per-brand `tokens.css` so a
brand becomes a checkable `:root` contract). That dissent is recorded in
`../manifest.json` under source `design-md` (`dissentNote` /
`dissentDisposition`), the same way the `picsum.photos` disagreement between
open-design and stitch-skills is recorded, so it is not buried in a craft file
nobody re-reads. Task 33 is not blocked by it; whoever actions task 33 should
read `design-intent.md` §1 first.

## Licensing

Two hops for the vendored bytes, both verified by reading the upstream LICENSE
files (a third and fourth upstream reach only the two authored-here files, and
are recorded further down):

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

A **fourth** upstream reaches only `design-intent.md`, and reaches it as ideas
rather than as bytes:

4. `google-labs-code/design.md` — Apache-2.0
   (`../licenses/google-labs-code-design-md-Apache-2.0.txt`), from
   `PHILOSOPHY.md` at commit `9bf8eae`. Nothing is redistributed and no code is
   ported; the three arguments are paraphrased. Both projects are Apache-2.0,
   so a verbatim lift would have been permissible with attribution — paraphrase
   was chosen to keep §4(b) modification-notice bookkeeping out of a subtree
   whose whole value rests on every other file being byte-identical to a
   *different* upstream. The licence text ships anyway: attribution is owed
   even where redistribution is not.

   That licence is a **third distinct Apache-2.0 rendering** in
   `../licenses/`. It was diffed against both the open-design and stitch-skills
   copies and differs from each (§1 "submitted to the Licensor", §6, §9, and
   the §4(a)/(b) indentation). None substitutes for another.
