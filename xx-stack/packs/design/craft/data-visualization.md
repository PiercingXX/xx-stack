# Data visualization craft rules

Universal rules for charts. The active `DESIGN.md` supplies the hues; this
file decides how many there may be, what each one is allowed to mean, what
has to be true of them before they ship, and when the answer is not a chart.

> Grounded in: WCAG 2.2 SC 1.4.1 (Use of Color) and 1.4.11 (Non-text
> Contrast); OKLab/OKLCH (Björn Ottosson, 2020) for perceptual ΔE;
> Brettel/Viénot/Mollon CVD simulation; Cleveland & McGill 1984 (JASA 79)
> on elementary perceptual tasks; Tufte's data-ink ratio. Threshold values
> and the six-check procedure are the method used by Claude Code's bundled
> `dataviz` skill, re-derived here rather than copied — see "Provenance"
> at the foot of this file.

## Why this file exists: the pack contradicted itself

Before this section shipped, an agent asked for a six-series chart faced
three rules with no way through:

| Rule | Says |
|---|---|
| `color.md` → Accent discipline | at most **2** visible uses of `--accent` per screen |
| `anti-ai-slop-rules.json` → `accent-overuse` (P1) | fires at **6** uses of `var(--accent)` |
| `anti-ai-slop-rules.json` → `raw-hex` (P1) | fires at **12** raw hexes outside `:root` |

…and no categorical tokens existed anywhere in the pack to reach for
instead. Reusing the accent tripped one rule; inventing hexes tripped
another.

**The resolution: series color is not accent color.** They are different
roles that happen to be colorful.

- `--accent` is an *attention* token. It says "act here." Scarcity is the whole mechanism, so the cap of 2 stands exactly as `color.md` writes it.
- `--series-N` is an *identity* token. It says "this one is Europe." It carries no urgency and competes for no attention, so the accent cap does not apply to it and never did.

A chart with eight series therefore uses **zero** accent uses and eight
series tokens, and trips neither rule. Series tokens live in `:root` like
every other token, so `raw-hex` is satisfied by construction. If your
accent and your `--series-1` are the same hue, that is a coincidence of
palette, not a shared role — and the accent cap still counts only the
accent uses.

## The procedure, in order

Color is step three, not step one. Most bad charts pick colors first.

1. **Pick the form from the data's job** — magnitude, identity, polarity, change over time, or a single headline. Sometimes the answer is *not a chart*: one number is a stat tile, and two numbers are a sentence.
2. **Lay out the marks and axes**, with grid and axes recessive.
3. **Assign color by the job it does** — categorical, sequential, diverging, or status. One rule each, below.
4. **Validate the palette against the thresholds.** Compute it; do not eyeball it.
5. **Add the non-color encoding** — legend, direct labels, texture, or shape — so identity never rests on hue alone.

## The four color jobs

Each job takes one structure. Mixing them is the most common failure.

| Job | Structure | Token |
|---|---|---|
| **Categorical** — identity, no order (regions, products) | N distinct hues in a **fixed order** | `--series-1` … `--series-8` |
| **Sequential** — magnitude, ordered (density, volume) | **one** hue, light → dark, monotonic lightness | `--seq-1` … `--seq-N` |
| **Diverging** — polarity around a meaningful midpoint (profit/loss, sentiment) | **two** hues + a **neutral gray** midpoint | `--div-neg-*` / `--div-pos-*` |
| **Status** — state (healthy, degraded, failing) | reserved semantic colors | `--good` / `--warning` / `--bad` |

Hard rules that fall out of the table:

- **Never a rainbow for sequential data.** Hue is not ordered; lightness is. A viridis-style ramp works because its lightness is monotonic, not because it has many hues.
- **Never a hue at the diverging midpoint.** The midpoint is where the value stops mattering — it gets gray.
- **Status colors are reserved and never become "series 4."** They ship with an icon or label, never color alone, and `--bad` on a chart must always mean bad.
- **Categorical hues are assigned in fixed order and never cycled.** Series 9 does not wrap to `--series-1`.

## Categorical: the token contract

```css
:root {
  --series-1: …;  /* assigned in this order, always */
  --series-2: …;
  /* … through --series-8 */
}
```

- **Color follows the entity, not its rank.** If a filter drops series 3, series 4 keeps its own color — it does not slide up into slot 3. A chart that repaints its survivors when the data is filtered is unreadable across two screenshots.
- **Eight slots is the ceiling.** A ninth series folds into "Other", becomes small multiples, or moves to a second encoding. It is never a generated hue: past eight, no ordering clears the separation floors.
- **Three slots is the ceiling for all-pairs forms.** In a bar, line, or stacked chart, only *adjacent* series touch, so only adjacent pairs must separate. In a scatter, bubble, choropleth, or small-multiple grid, **any** two series can land side by side, so every pair must clear the floor. That is a much harder test and a realistic eight-hue palette will not pass it. Cap those forms at three series and facet the rest.

## The acceptance thresholds

Run these as numbers. "It looks fine to me" is not a check, and the
protanopia case in particular is invisible to a normal-vision reviewer.

| Check | Threshold | Why |
|---|---|---|
| Lightness band | all slots within one band (e.g. OKLCH L 0.43–0.77 on a light surface) | slots outside the band read as emphasis rather than identity |
| Chroma floor | OKLCH C ≥ 0.1 | a near-gray slot reads as "disabled", not as a series |
| **CVD separation** | adjacent-pair ΔE ≥ **8** (OKLab ×100) under protan, deutan and tritan simulation | ~8% of men have a CVD; ΔE 6–8 is a floor that is legal **only** with a second encoding |
| **Normal-vision floor** | adjacent-pair ΔE ≥ **15** | below this, full-color readers cannot separate the pair either; a second encoding does **not** excuse it |
| Contrast vs surface | ≥ 3:1 (WCAG 1.4.11) | a slot below 3:1 obligates **relief**: visible direct labels or a table view. Not dismissable |

A slot failing the lightness or chroma check is re-stepped on the same
hue ramp. A pair failing CVD separation is re-ordered or re-stepped. A
palette failing the normal-vision floor is reduced in count — that one
cannot be encoded around.

## Dark mode is selected, not flipped

A categorical palette validated on a light surface is **not** valid on a
dark one. Contrast is measured against the surface, and the surface moved.

Step the same hues for the dark band and validate the set again against
the dark surface. Do not invert lightness algorithmically and do not
assume a light-mode pass transfers — the worst adjacent pair is usually
a *different* pair in each mode. See `layering.md` for the matching point
about elevation: shadows and color both stop working the same way on a
dark surface, for the same reason.

## Non-color encoding is mandatory, not a nicety

WCAG 1.4.1 (Level A) forbids color as the **only** means of conveying
information. A chart whose series are distinguishable only by hue fails
it outright.

- **Two or more series → a legend is always present.** A single series needs no legend box; the title names it.
- **Four or fewer series → also direct-label them.** Direct labels beat a legend because they remove the lookup.
- **Never a number on every point.** Label the endpoints, the extremes, and the ones being argued about.
- **Ship a table view** for any chart carrying values a reader might need exactly. It is also the relief mechanism for the contrast WARN above.
- **Texture** (a directional fill at 45°/135°) is the fallback for print, monochrome, and `forced-colors: active`, where your hues are replaced by system colors wholesale.
- **Text wears text tokens, never the series color.** Values, axis labels, and legend text stay in the normal ink tokens; a small colored mark *beside* the label carries the identity. Colored text at small sizes fails contrast far more often than a colored 12px swatch does.

## One axis

**Never a dual-axis chart.** Two y-scales on one plot let the author
place the crossover anywhere they like, so the correlation a reader sees
is an artifact of the scaling choice. It is the single most common
serious chart mistake.

Two measures of different scale become: two charts, small multiples, or
both series indexed to a common base (t₀ = 100).

Related axis rules:

- **Bar charts start at zero.** Length is the encoding; truncating the axis lies about the ratio.
- **Line charts need not start at zero** — position is the encoding, not length — but the axis range must be stated.
- **Recessive grid and axes.** Grid lines sit at the level of a hairline border, never competing with the data.

## Common mistakes (lint these)

- Series colored with `var(--accent)` repeated N times. That is what `--series-N` is for, and it is what makes `accent-overuse` fire on a legitimate chart.
- Raw hex values for series, inline on the marks. Tokens go in `:root`; this is what `raw-hex` is catching.
- A ninth series produced by generating or cycling a hue.
- Colors reassigned by rank, so a filter repaints the surviving series.
- A rainbow ramp for sequential data, or any hue at a diverging midpoint.
- `--good` / `--bad` reused as ordinary categorical slots.
- A light-mode palette shipped unchanged into dark mode.
- Dual-axis charts. Two scales, one plot, any conclusion you like.
- A truncated y-axis on a bar chart.
- Series distinguishable by hue alone — no legend, no labels, no texture. Fails WCAG 1.4.1 at Level A.
- A value printed on every single data point.
- Axis labels or values set in the series color rather than a text token.
- Eight series in a scatter or choropleth, where every pair must separate and only three can.
- A palette signed off by looking at it. The protan and tritan cases are not visible to a normal-vision reviewer; they are computed or they are unknown.
- A chart at all, where the data is one number. That is a stat tile.

## Provenance

The six-check procedure, the ΔE thresholds, the eight-slot ceiling and
the three-slot all-pairs cap are the method used by the `dataviz` skill
bundled with Claude Code (Anthropic), read at bundle version `2.1.232`.

That skill's **reference palette is deliberately not reproduced here.**
Its hex values were run through its own validator during this file's
authoring and do pass — worst adjacent CVD ΔE 9.1 light / 8.4 dark,
worst adjacent normal-vision ΔE 19.6 light / 19.3 dark, with the first
three slots clearing the all-pairs floors in both modes — but a bundled
skill carries no upstream `LICENSE` this repository can read, and
`packs/design/manifest.json` records a license only when one was read
from the source itself. Copying eighty-odd unlicensed hex values into a
pack whose entire value rests on verified provenance would trade the
thing that makes it trustworthy for a convenience.

It is also the wrong shape. `craft/` states what is true regardless of
brand; `design-systems/*/DESIGN.md` supplies the values. Thresholds are
craft. Hues are brand. A design system that wants a categorical palette
declares `--series-1…N` in its own file and validates it against the
table above.
