# Iconography craft rules

Universal rules for icons. The active `DESIGN.md` decides an icon set's
personality — geometric or humanist, rounded or square-cut. This file
decides what has to be true of any icon before it ships, and what to use
instead of the thing the pack bans.

> Grounded in: SVG 2 (`stroke-width`, `vector-effect`), CSS Values 4
> (`currentColor`), WAI-ARIA 1.3 and the ARIA APG on accessible names,
> WCAG 2.2 SC 1.1.1 Non-text Content (A) and 1.4.11 Non-text Contrast (AA),
> and Unicode TR51 on emoji presentation.

## This file exists because the pack banned the shortcut

`anti-ai-slop.md` treats emoji-as-icons as a **P0** failure, enforced by
two separate rules in `anti-ai-slop-rules.json` (`emoji-icon` and
`emoji-icon-class`). It is the single most reliable tell of generated UI.

Until this section shipped, that ban named no replacement — the pack
forbade the easy path and said nothing about the correct one. The answer
is inline SVG, and the rest of this file is what makes it good.

## Why emoji fail as icons

Worth stating once, so the rule reads as a conclusion rather than a taste:

- **They are not yours.** Emoji render in the platform's font — Apple, Google, Microsoft and Samsung all draw them differently. The same interface is a different interface on each.
- **They cannot take your color.** A multicolor glyph ignores `currentColor`, so it cannot match its label, cannot dim when disabled, and cannot invert in dark mode.
- **They are text to a screen reader.** 🚀 announces as "rocket", inside a button labelled "Deploy".
- **Their metrics are wrong.** Emoji sit on the text baseline with their own advance width, so they never optically align with a text label the way a sized icon does.
- **They carry drift.** Meanings shift by platform and by year in a way a drawn glyph does not.

## Inline SVG is the default

Not an icon font, not an `<img>`, not a background image.

- **Inline SVG takes `currentColor`**, so an icon inherits its label's color automatically — including hover, disabled, and both themes, with no extra rules.
- **An icon font renders as text**, which means it can be blocked, substituted by a font fallback into visible garbage, and is a known screen-reader hazard when built from private-use codepoints.
- **`<img>` and `background-image` cannot be recolored** and, in `forced-colors: active`, a background image is dropped entirely.
- **External sprite files break the self-contained artifact rule.** Everything this pack ships is one file; `external-image` is already a P1 rule.

```html
<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M5 12h14M12 5l7 7-7 7"/>
</svg>
```

## One grid, one stroke, one set

Icons read as a system or they read as clip art. Three things create the
system, and mixing any of them breaks it.

- **One grid.** Pick a `viewBox` — 24×24 is the common default — and draw everything on it. Mixing a 16-grid icon with a 24-grid icon puts their details at different densities even when both are rendered at the same size.
- **One stroke width**, typically 1.5–2 at a 24 grid. This is the most visible inconsistency there is: a 1px icon beside a 2px icon looks like a rendering bug.
- **One source set.** Do not mix libraries. Two sets drawn on the same grid at the same stroke still disagree on corner radius, terminal style, and how much detail an icon carries.

**Stroke does not scale the way you want.** An SVG scaled from 24 to 48
doubles its stroke to 3px. Either use the set's own size variants, or set
`vector-effect="non-scaling-stroke"`, or scale the `stroke-width` down to
compensate. An icon enlarged for a hero and left at its default stroke is
the usual cause of "this icon looks heavy."

## Optical size and alignment

- **Match the icon to the text it sits with**, not to a round number. Beside 16px text, a 20px icon usually reads correctly and a 16px one reads small — glyph height is less than the em box.
- **Align optically, not mathematically.** Centering an icon's bounding box beside a label frequently looks low, because the label's visual center sits at its x-height rather than its box center.
- **Give complex glyphs more room.** At 16px and below, a detailed icon becomes noise. Below 16px, use only the simplest shapes in the set.
- **Keep the hit target independent of the glyph.** A 20px icon in a 44px button is correct; scaling the glyph up to fill the target is not. `accessibility-baseline.md` holds the target-size rules.

## Accessibility: the icon is not the name

The decision is binary, and getting it wrong in either direction is a
failure.

**Decorative** — the icon repeats a visible adjacent label. Hide it, or
the name is announced twice:

```html
<button>
  <svg aria-hidden="true" focusable="false">…</svg>
  Delete
</button>
```

**Meaningful** — the icon *is* the control, with no visible text. It needs
an accessible name:

```html
<button aria-label="Delete">
  <svg aria-hidden="true" focusable="false">…</svg>
</button>
```

Put the name on the **button**, not on the SVG. Naming the SVG and leaving
the button unnamed works in some screen readers and not others; naming the
control is what the ARIA APG specifies and what `accessibility-baseline.md`
already requires under 4.1.2.

`focusable="false"` matters because older Internet Explorer-era engines put
SVG elements in the tab order; it is cheap insurance and does no harm.

**Contrast.** A meaningful icon is a non-text UI component and needs
**3:1** against its background under 1.4.11. A decorative icon has no
contrast requirement — but if it is genuinely invisible, it is decoration
that should be deleted rather than dimmed.

**Never an icon alone for status.** Color plus shape is fine; color alone
fails 1.4.1. A red circle and a green circle differing only in hue convey
nothing to a viewer with a CVD — the same rule `data-visualization.md`
applies to chart series.

## Forced colors

Under `@media (forced-colors: active)`, an SVG using `currentColor`
follows the system text color automatically, which is the behaviour you
want and another reason to prefer it. A `fill` hardcoded to a hex will be
overridden; a background-image icon disappears. Set
`forced-color-adjust: none` **only** where you are deliberately re-asserting
a system color pair, never to preserve a brand color.

## Common mistakes (lint these)

- Emoji used as icons. P0, and detected — `emoji-icon` and `emoji-icon-class`.
- An icon font or an external sprite sheet instead of inline SVG.
- Icons from two different libraries in one artifact.
- Mixed stroke widths, or mixed `viewBox` grids.
- An icon scaled up with its stroke left to scale too, so it renders heavy.
- `fill="#333"` hardcoded instead of `currentColor`, so the icon does not follow its label into dark mode, disabled state, or forced colors.
- A decorative icon left announceable, so a screen reader reads the label twice.
- An icon-only button with no `aria-label` — an unnamed control.
- `aria-label` on the `<svg>` instead of on the `<button>`.
- A meaningful icon below 3:1 against its background. Fails 1.4.11.
- Status conveyed by icon color alone. Fails 1.4.1.
- An icon sized to fill its hit target rather than sized to its adjacent text.
- A detailed multi-path glyph rendered at 12px, where it is mud.
