# Design pack — brand systems, aesthetic skills, workflow skills

Design payloads consumed by `design-engineer` and the design skills. This pack
is mostly **vendored third-party content**, not original work of this
repository. Do not reformat it — `xx-stack/packs/` is in `.prettierignore` so
that these files stay byte-comparable against their upstreams.

## Layout

| Path | What it is | Origin |
|---|---|---|
| `design-systems/` | 151 brand design systems, one `DESIGN.md` each | vendored |
| `design-skills/` | 57 aesthetic styles, `SKILL.md` + `DESIGN.md` each | vendored |
| `workflow-skills/` | 31 artifact workflow skills | vendored |
| `craft/` | 11 brand-agnostic craft rulebooks + the anti-slop rule table + one doctrine note | vendored (3 files authored here) |
| `evals/golden-tasks/` | agent grading fixtures | authored here |
| `scripts/` | catalog generator, the two design gates, and two checks | authored here |
| `DESIGN-CATALOG.md` | generated index (`npm run design:catalog`) | generated here |

`craft/` is a **fourth axis** and the newest part of this pack.
`design-systems/` says what a brand looks like, `design-skills/` supplies
aesthetic direction, `workflow-skills/` says how to build one artifact type —
`craft/` supplies the rules that hold regardless of brand (ALL CAPS needs
≥0.06em tracking; every stateful surface needs empty/loading/error/partial
states). A skill opts in with `od.craft.requires` in its frontmatter and pays
context tokens only for the sections it names — the same "smallest mechanism
that changes the agent's decisions" principle `packs/rules` applies with its
nano/mini/full tiers. Twelve of the 31 workflow skills are bound; the other 19
are deliberately unbound. See [`craft/XX-STACK-NOTES.md`](craft/XX-STACK-NOTES.md).

A twelfth shipped section, [`craft/design-intent.md`](craft/design-intent.md),
is authored here and is **doctrine rather than a rulebook** — no gate reads it
and no skill binds it. It states the theory behind
`craft/anti-ai-slop-rules.json`'s 18 checkable rules, and records a dissent that
bears on `UPSTREAM-BORROW-TODO.md` task 33.

[`manifest.json`](manifest.json) is the machine-readable version of everything
below, with a per-subtree `provenance` field.

## Attribution and licensing

Five upstream projects supply this pack. Their license texts are copied
verbatim into [`licenses/`](licenses/), plus one per-skill license that upstream
itself carves out.

| Upstream | License | Text | Supplies |
|---|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | Apache-2.0 | [`licenses/nexu-io-open-design-Apache-2.0.txt`](licenses/nexu-io-open-design-Apache-2.0.txt) | 150 of 151 `design-systems/`, all 31 `workflow-skills/`, all 13 vendored `craft/` files |
| [bergside/awesome-design-skills](https://github.com/bergside/awesome-design-skills) | MIT, © 2026 Bergside | [`licenses/bergside-awesome-design-skills-MIT.txt`](licenses/bergside-awesome-design-skills-MIT.txt) | all 57 `design-skills/` |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | MIT, © 2026 VoltAgent | [`licenses/voltagent-awesome-design-md-MIT.txt`](licenses/voltagent-awesome-design-md-MIT.txt) | `design-systems/bmw-m/` only |
| [referodesign/refero_skill](https://github.com/referodesign/refero_skill) | MIT, © 2026 Refero | [`licenses/referodesign-refero_skill-MIT.txt`](licenses/referodesign-refero_skill-MIT.txt) | nothing directly — second hop of the `craft/` chain (see below) |
| [google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills) | Apache-2.0 | [`licenses/google-labs-code-stitch-skills-Apache-2.0.txt`](licenses/google-labs-code-stitch-skills-Apache-2.0.txt) | rule values only: 7 of the 18 rules in `craft/anti-ai-slop-rules.json`, plus part of an 8th |
| [google-labs-code/design.md](https://github.com/google-labs-code/design.md) | Apache-2.0 | [`licenses/google-labs-code-design-md-Apache-2.0.txt`](licenses/google-labs-code-design-md-Apache-2.0.txt) | prose doctrine only — three `PHILOSOPHY.md` arguments restated in our own words in `craft/design-intent.md`; no file redistributed, no code ported |
| op7418 (歸藏) | MIT | [`workflow-skills/guizang-ppt/LICENSE`](workflow-skills/guizang-ppt/LICENSE) | `workflow-skills/guizang-ppt/` |

`workflow-skills/guizang-ppt/LICENSE` is the author's own license, shipped
inside the skill directory exactly as upstream ships it. It overrides the
repo-wide Apache-2.0 for that directory. **Do not move, edit, or delete it.**

All three Apache-2.0 texts are shipped separately even though the license is the
same one. Each pair was diffed: the renderings differ in line-wrapping, in the
§1, §4, §6 and §9 wording, and in the appendix copyright line, so none was
assumed to stand in for another.

Content authored in this repository — `evals/`, `scripts/`, `craft/XX-STACK-NOTES.md`,
`craft/anti-ai-slop-rules.json` (its structure; the rule *values* are the two
Apache-2.0 upstreams'), `craft/design-intent.md` (its text; the *ideas* are
attributed to a third Apache-2.0 upstream and restated, not copied),
`workflow-skills/quality-gates.json`, and the generated
`DESIGN-CATALOG.md` structure — is covered by the repo root
[MIT LICENSE](../../LICENSE).

#### The `craft/` chain has two hops

`nexu-io/open-design` attributes `craft/` as adapted from `referodesign/refero_skill`.
That was verified rather than taken on trust: refero's `LICENSE` was read from
the repo (MIT, "Copyright (c) 2026 Refero" — note upstream's prose says
"© Refero Design"; the license text itself says the shorter form), three craft
files carry an inline "Adapted from refero_skill (MIT)" blockquote, and diffing
refero's `references/{anti-ai-slop,color,typography}.md` against open-design's
counterparts shows a heavy rewrite, not a copy. The other eight rulebooks carry
no refero attribution and postdate the three that do. Both license texts ship;
the bytes we hold are open-design's.

### What is known, and how

Every claim above was established on **2026-08-03** by md5 byte-comparison of
each pack file against upstream content fetched from GitHub, and by reading the
upstream `LICENSE` files directly. No license was inferred from a README, from
a project's general reputation, or from memory.

- **`design-systems/`** — re-vendored 2026-08-03 at a **pinned** commit,
  `nexu-io/open-design` `e1c277c5` (subtree `049e1fa9b`). 138 of the 150
  open-design files are byte-identical to that pin. Only **12** differ, and
  now for exactly two reasons: local de-branding applied by commit `d458c02`
  (e.g. `voltagent/DESIGN.md`: "GitHub stars badge" → "community badge"), and
  the 2026-08-03 contrast fix to four files whose declared Text/Surface pair
  fell below WCAG AA (`bold`, `energetic`, `mono`, `pacman` — one token each,
  recorded in `manifest.json` under `resolvedContentDefects`). The third cause
  this list used to carry — upstream drift — is gone: the seven drifted files
  (`arc`, `canva`, `discord`, `duolingo`, `github`, `huggingface`, `openai`)
  were realigned to the pin, each having differed only by a "Usage Guardrails"
  section upstream added after our snapshot. The 151st, `bmw-m`, is
  byte-identical to `VoltAgent/awesome-design-md` apart from one renamed
  frontmatter `name:` field, and is deliberately **not** realigned to
  open-design's own unrelated `bmw-m`.

  Upstream still ships all four contrast defects at the pinned sha — that was
  re-verified during the re-vendor, not assumed. A naive overwrite of this
  subtree would silently reintroduce 1.06:1 body text; `design:systems-lint`
  is the gate that catches it.
- **`design-skills/`** — 49 of 57 `SKILL.md` and 49 of 57 `DESIGN.md` are
  byte-identical to `bergside/awesome-design-skills` at `f631a09`.
  `enterprise` was rewritten upstream after our snapshot. Seven slugs
  (`application`, `dashboard`, `elegant`, `energetic`, `luxury`,
  `publication`, `simple`) no longer exist upstream. All 57 nonetheless carry
  `license: MIT` and `metadata.author: typeui.sh` in their own frontmatter, so
  the license is established per file regardless of the upstream path.
- **`workflow-skills/`** — all 31 slugs exist upstream at
  `nexu-io/open-design design-templates/<slug>/`; 6 are byte-identical to
  `dceac12`, 25 differ by small deltas (local pruning of unused upstream
  frontmatter, plus upstream drift). All 31 retain upstream's `od:` frontmatter
  block, which is what identifies their origin from inside the files.
- **`craft/`** — all 13 vendored files are byte-identical to
  `nexu-io/open-design` at `dceac12`, verified by `git hash-object` against
  `git rev-parse HEAD:craft/<file>`. Zero local edits, so the Apache-2.0 §4(b)
  modified set for this subtree is empty. Honest caveat: three of the eleven
  rulebooks (`typography`, `color`, `anti-ai-slop`) and upstream's README landed
  on 2026-05-02, about twelve hours *before* this pack's vendoring window
  opened — we simply did not take them at the time. The other eight landed
  later and are ~90% of the bytes.
- **`craft/anti-ai-slop-rules.json`** — authored here, and the one file in this
  pack drawing on `google-labs-code/stitch-skills`. It holds 18 rules as data
  (10 from open-design, 7 from stitch-skills, 1 combining both), each tagged
  with its `source`, plus a `notAdopted` list recording 15 upstream rules that
  were deliberately refused and why. No upstream *code* was copied — the
  enforcement engine in `scripts/quality-gate-html.mjs` was written here, which
  is what keeps it MIT while the rule values stay Apache-2.0.
- **`craft/design-intent.md`** — authored here, and the only file in this pack
  written from an upstream whose bytes we deliberately did **not** take. Three
  arguments from `google-labs-code/design.md`'s `PHILOSOPHY.md` (Apache-2.0,
  read at `9bf8eae`) are restated in our own words; nothing is reproduced, so
  there is nothing to byte-compare and nothing to keep in sync. Its licence text
  ships anyway — attribution is owed even where redistribution is not. One of
  its arguments dissents from `UPSTREAM-BORROW-TODO.md` task 33; that dissent is
  recorded in `manifest.json` under source `design-md`, not only in the file.

### What is *not* known

- **The commit each subtree was vendored at.** It was never recorded. Drift can
  therefore only be measured against upstream HEAD, which cannot distinguish a
  local edit from an upstream change without reading each diff.
  `packs/rules/manifest.json` pins its upstream sha; this pack does not.
- **Whether the modification notice is placed correctly.** Apache-2.0 §4(b)
  requires modified files to state that they changed. `manifest.json` lists the
  40 Apache-2.0 files that differ from upstream centrally, rather than
  annotating each file in place — and it cannot say, without reading every
  diff, which of those 40 differ because *we* changed them versus because
  upstream moved. That keeps the files byte-comparable against upstream, but it
  is a judgement call nobody has ratified.
- **Trademark posture.** `design-systems/` names roughly 100 real brands in its
  headings and prose. The content is descriptive analysis of publicly
  observable visual language rather than copied brand assets, and the risk is
  inherited from upstream rather than created here — but no explicit decision
  has been recorded in this repo.

### A correction

An earlier internal description characterised `design-systems/` as clean-room
reinterpretation authored here, on the strength of its "Design System Inspired
by X" framing. That is wrong. The framing is upstream's, and 138 of 151 files
are byte-identical copies. This pack **redistributes** that content under
Apache-2.0 and MIT; it did not originate it.

## Gates

- `npm run design:catalog` — regenerate `DESIGN-CATALOG.md` (deterministic)
- `npm run design:golden` — grade the golden-task response fixtures
- `npm run design:html-gate` — HTML quality gate over pack templates and examples
- `npm run design:systems-lint` — read-only lint over all 151 `design-systems/`
  files: colour-token extraction, WCAG AA on the text/surface pair each file's
  own prose declares, and section order against the two schemas this pack ships

`design:systems-lint` checks contrast **only** on pairs a file explicitly tells
an agent to use together — the 57 Schema-B files that say "Use Surface (#…) for
large backgrounds" and "Keep body copy on Text (#…) for legibility". Bucketing
tokens by role and cross-producing them was measured at 52.4% false positives
on this corpus and must not be reintroduced; the reasoning is in the script's
header comment. It runs four fixtures in `evals/design-system-lint/` on every
invocation, because a structural check calibrated to its own corpus passes
151/151 on day one and would otherwise be proving nothing.

The HTML gate now reports anti-slop findings on a **P0/P1/P2 ladder** — the
same vocabulary every `workflow-skills/*/references/checklist.md` already uses.
Severity is not exit code: **P0 fails**, alongside the pre-existing structural
checks; P1 and P2 report and do not fail. Findings name the rule id, the
offending value, and the token to use instead, so they are actionable in one
round. Exemptions live in `workflow-skills/quality-gates.json` and may now name
a **rule id** (`"rules": ["filler-copy"]`) rather than pattern-matching a
message — an exemption says which rule it silences, and carries a reason.

Two more checks ship here but are **not** wired into `npm run verify` (that
needs a `package.json` edit); run them directly:

- `node xx-stack/packs/design/scripts/check-craft-references.mjs` — every
  `od.craft.requires` slug resolves to a `craft/<slug>.md` or a
  `craft/FUTURE_SECTIONS.md` entry, so a typo cannot silently drop a section
- `node xx-stack/packs/design/scripts/test-anti-slop-rules.mjs` — drives the
  real gate against a slop fixture and a clean one; asserts every rule fires at
  its declared severity, that none fire on clean input, and that only P0
  changes the exit code
