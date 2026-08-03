# Design pack — brand systems, aesthetic skills, workflow skills

Design payloads consumed by `design-engineer` and the design skills. This pack
is mostly **vendored third-party content**, not original work of this
repository. Do not reformat it — `xx-stack/packs/` is in `.prettierignore` so
that these files stay byte-comparable against their upstreams.

## Layout

| Path | What it is | Origin |
|---|---|---|
| `design-systems/` | 137 brand design systems, one `DESIGN.md` each | vendored |
| `design-skills/` | 57 aesthetic styles, `SKILL.md` + `DESIGN.md` each | vendored |
| `workflow-skills/` | 31 artifact workflow skills | vendored |
| `evals/golden-tasks/` | agent grading fixtures | authored here |
| `scripts/` | catalog generator and the two design gates | authored here |
| `DESIGN-CATALOG.md` | generated index (`npm run design:catalog`) | generated here |

[`manifest.json`](manifest.json) is the machine-readable version of everything
below, with a per-subtree `provenance` field.

## Attribution and licensing

Three upstream projects supply this pack. Their license texts are copied
verbatim into [`licenses/`](licenses/), plus one per-skill license that upstream
itself carves out.

| Upstream | License | Text | Supplies |
|---|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | Apache-2.0 | [`licenses/nexu-io-open-design-Apache-2.0.txt`](licenses/nexu-io-open-design-Apache-2.0.txt) | 136 of 137 `design-systems/`, all 31 `workflow-skills/` |
| [bergside/awesome-design-skills](https://github.com/bergside/awesome-design-skills) | MIT, © 2026 Bergside | [`licenses/bergside-awesome-design-skills-MIT.txt`](licenses/bergside-awesome-design-skills-MIT.txt) | all 57 `design-skills/` |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | MIT, © 2026 VoltAgent | [`licenses/voltagent-awesome-design-md-MIT.txt`](licenses/voltagent-awesome-design-md-MIT.txt) | `design-systems/bmw-m/` only |
| op7418 (歸藏) | MIT | [`workflow-skills/guizang-ppt/LICENSE`](workflow-skills/guizang-ppt/LICENSE) | `workflow-skills/guizang-ppt/` |

`workflow-skills/guizang-ppt/LICENSE` is the author's own license, shipped
inside the skill directory exactly as upstream ships it. It overrides the
repo-wide Apache-2.0 for that directory. **Do not move, edit, or delete it.**

Content authored in this repository — `evals/`, `scripts/`,
`workflow-skills/quality-gates.json`, and the generated `DESIGN-CATALOG.md`
structure — is covered by the repo root [MIT LICENSE](../../LICENSE).

### What is known, and how

Every claim above was established on **2026-08-03** by md5 byte-comparison of
each pack file against upstream content fetched from GitHub, and by reading the
upstream `LICENSE` files directly. No license was inferred from a README, from
a project's general reputation, or from memory.

- **`design-systems/`** — 121 of 137 files are byte-identical to
  `nexu-io/open-design` at `dceac12`. 15 differ by small deltas with two
  observed causes: local de-branding applied by commit `d458c02` (e.g.
  `voltagent/DESIGN.md`: "GitHub stars badge" → "community badge"), and
  upstream drift since vendoring (e.g. `arc/DESIGN.md` lacks a
  "Usage Guardrails" section upstream has since added). The 137th, `bmw-m`, is
  byte-identical to `VoltAgent/awesome-design-md` apart from one renamed
  frontmatter `name:` field.
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
by X" framing. That is wrong. The framing is upstream's, and 121 of 137 files
are byte-identical copies. This pack **redistributes** that content under
Apache-2.0 and MIT; it did not originate it.

## Gates

- `npm run design:catalog` — regenerate `DESIGN-CATALOG.md` (deterministic)
- `npm run design:golden` — grade the golden-task response fixtures
- `npm run design:html-gate` — HTML quality gate over pack templates and examples
