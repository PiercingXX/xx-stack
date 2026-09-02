# craft/ in xx-stack — what applies here and what does not

**This file is authored in xx-stack.** So are `anti-ai-slop-rules.json`,
`design-intent.md`, `layering.md`, `data-visualization.md`, `responsive.md`,
`theming.md`, and `iconography.md`. **Every other file in `craft/` is
vendored byte-for-byte from `nexu-io/open-design`** (see `../manifest.json`,
subtree `craft/`). The
vendored files are never edited, because byte-comparability against upstream is
the only way to tell our changes from upstream drift.

Three kinds of file live here, and conflating them is the mistake this note
exists to prevent:

| Kind | Files | Rule |
|---|---|---|
| Vendored | the 11 rulebooks + `README.md` + `FUTURE_SECTIONS.md` | never edit; byte-identical to `dceac12` |
| Authored here, from upstream material we hold | `anti-ai-slop-rules.json`, this file | ours; rule *values* attributed per-entry |
| Authored here, from ideas we did **not** take | `design-intent.md`, `layering.md`, `data-visualization.md`, `responsive.md`, `theming.md`, `iconography.md` | ours; nothing to byte-compare, nothing to sync |

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

The six sections authored here — `design-intent.md`, `layering.md`,
`data-visualization.md`, `responsive.md`, `theming.md` and `iconography.md` —
are bound to **no** skill, on purpose. Every binding in the table above is
upstream's at `dceac12`, transcribed unchanged; upstream has no binding for a
file it does not have, and inventing one would break exactly the provenance
rule that makes the table trustworthy. All six still resolve as
`od.craft.requires` slugs, so a skill can opt in later without a code change.
`check-craft-references.mjs` therefore reports `craft sections shipped: 17` and
names `design-intent`, `layering`, `data-visualization`, `responsive`, `theming`
and `iconography` under "shipped but required by no skill" — a NOTE, not a
failure, and the expected steady state.

Four more sections landed 2026-08-14, each filling a gap measured against the
skills this pack already ships rather than proposed on taste:

| Section | The gap it closes |
|---|---|
| `data-visualization.md` | Eight workflow skills name a chart type and ten `example.html` files contain plotted geometry, while `craft/` said one thing about charts: an alt-text line in `accessibility-baseline.md`. Worse, the rules actively conflicted — see below. |
| `responsive.md` | `scripts/quality-gate-html.mjs` warns "No @media query found; verify responsive behavior" and no rulebook stood behind that warning. The gate named a defect; nothing said what correct looked like. |
| `theming.md` | `color.md` §Dark themes covers dark *values* in twelve lines and nothing covers the *mechanism* — `prefers-color-scheme`, the `color-scheme` property, or the three-state light/dark/system problem. Companion rather than an edit, because `color.md` is vendored. |
| `iconography.md` | `anti-ai-slop.md` bans emoji-as-icons at P0 with two enforced rules and named no replacement. Zero craft files mentioned icon systems, stroke weight, or optical sizing. |

### The conflict `data-visualization.md` resolves

This one was not a gap but a contradiction, and it is recorded because the
fix is a *ruling*, not new material. An agent asked for a six-series chart
faced `color.md`'s cap of two visible `--accent` uses per screen, the
`accent-overuse` rule firing at six, and the `raw-hex` rule firing at twelve
hexes outside `:root` — with no categorical tokens anywhere in the pack to
use instead. A grep for `--chart-N` / `--series-N` / `--cat-N` across all 149
design systems, 57 design skills, 31 workflow skills and `craft/` returned
nothing. Every available route tripped a rule.

The ruling: **series color is an identity role, accent color is an attention
role.** The accent cap counts accent uses and never applied to series
tokens; `--series-N` lives in `:root` like any other token, so `raw-hex` is
satisfied by construction. `color.md` is unchanged and unchallenged — the
contradiction was in what the pack failed to say, not in what it said.

The pack's own `dashboard/example.html` shows the shape of the problem: it
holds exactly two accent uses and colors its chart from `--good`/`--bad`,
which works for two series and has no answer for five.

`layering.md` is the only craft file with **no upstream at all** — open-design
ships nothing on stacking contexts or z-index, and the gap was found by
reviewing `mui/material-ui`. Its MUI-derived content is two tables of shipped
values (the `zIndex` ladder and the elevation shadow alphas) read from
`zIndex.js` and `shadows.js` at `48c6663a`; the CSS stacking-context and
top-layer material is standard spec behaviour, not taken from any project. MUI
is MIT, which is compatible, but no MUI file is redistributed and no MUI code is
ported — the numbers are cited as reference values the way `animation-discipline.md`
cites Material 3 and Carbon motion tokens. See `../manifest.json` source
`material-ui`.

### A stale entry in `FUTURE_SECTIONS.md`

`FUTURE_SECTIONS.md` lists `motion-discipline` as a planned forward reference,
but the shipped equivalent is `animation-discipline` and upstream's own README
says so further down. That slug will therefore never resolve to a file, and
`check-craft-references.mjs` will accept it forever — a permanently-valid
reference to nothing.

It is recorded here rather than removed, because `FUTURE_SECTIONS.md` is one of
the 13 vendored files and this subtree's value rests on all 13 staying
byte-identical to `dceac12`. Deleting one line would open an Apache-2.0 §4(b)
modified set that is currently empty, to fix a stale entry that costs nothing at
runtime. The other two entries, `pixel-discipline` and `typographic-rhythm`, are
genuinely still unshipped and are not affected.

Resolve a slug with:

```bash
node packs/design/scripts/check-craft-references.mjs
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
premise of the repository history task 33 (vendor per-brand `tokens.css` so a
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
