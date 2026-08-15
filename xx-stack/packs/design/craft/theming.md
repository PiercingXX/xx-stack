# Theming craft rules

Universal rules for shipping one artifact that is correct in light and in
dark. The active `DESIGN.md` supplies the palette; this file decides how
that palette is structured so a second theme is a token swap rather than
a rewrite.

> Grounded in: CSS Color Adjust Level 1 (`color-scheme`, `forced-color-adjust`),
> CSS Media Queries Level 5 (`prefers-color-scheme`, `prefers-contrast`),
> WCAG 2.2 SC 1.4.3 and 1.4.11, and the CSS Cascade `:where()` specificity rules.

## Scope: this extends `color.md`, it does not replace it

`color.md` §Dark themes already holds the two rules that matter most about
dark *values* — avoid pure black and pure white, and prefer
semi-transparent white borders over solid dark ones on dark surfaces — and
§Semantic color naming already says to name tokens by purpose, never by
hue. Both stand; neither is restated here.

That file is vendored byte-for-byte from `nexu-io/open-design` and is
never edited (see `XX-STACK-NOTES.md`), so this companion carries the
mechanism: how the two themes are selected, declared, and kept from
fighting each other. `color.md` is about which colors. This is about how
a theme is switched.

## The three states, and why two blocks are not enough

Theme is not a boolean. There are three states, and the one that gets
missed is the default:

| State | How it presents | What must handle it |
|---|---|---|
| Explicit light | an attribute stamped on the root, e.g. `data-theme="light"` | an attribute-scoped block |
| Explicit dark | `data-theme="dark"` | an attribute-scoped block |
| **System (the default)** | **nothing stamped at all** — only `prefers-color-scheme` separates light from dark | a media query |

A page that defines its palette under `:root[data-theme="light"]` and
`:root[data-theme="dark"]` and nothing else renders **unstyled** for every
viewer who has never touched a toggle, which is most of them.

The working pattern:

```css
/* 1. Complete light palette on bare :root — the unconditional base. */
:root {
  --surface: #fafafa;
  --fg: #111111;
}

/* 2. Dark under the media query, guarded so an explicit light stamp wins. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface: #0f0f0f;
    --fg: #f0f0f0;
  }
}

/* 3. Dark again under the attribute, so the toggle wins in both directions. */
:root[data-theme="dark"] {
  --surface: #0f0f0f;
  --fg: #f0f0f0;
}
```

Three rules govern that shape:

- **Every token gets its value on bare `:root` first.** A color whose only definition lives inside a media query or an attribute block is undefined in the third state.
- **The media block needs the `:not([data-theme="light"])` guard.** Without it, a viewer on OS-dark who explicitly chose light gets dark anyway — the toggle silently fails one way.
- **Redefine only the tokens that change.** The dark blocks list surfaces and inks, not the whole system. A dark block that repeats every token is a second palette to keep in sync.

## `color-scheme` is not optional

The `color-scheme` property tells the browser which theme the page is in,
so it can style what CSS cannot reach: form controls, scrollbars, the
spellcheck underline, and the canvas behind the page.

```css
:root { color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; }
}
:root[data-theme="dark"] { color-scheme: dark; }
```

Omitting it is the cause of the most recognisable dark-mode bug: a dark
page with blazing white scrollbars and light-mode `<select>` dropdowns.
`color-scheme: light dark` declares support for both and lets the UA pick,
which is right for a page with no toggle of its own.

Also give `body` an explicit background token. A transparent body borrows
whatever is behind it, which in an embedded or previewed context is not
your theme.

## Dark is a designed palette, not an inversion

Do not compute dark from light. `filter: invert()` destroys images and
photographs and produces hues nobody chose.

- **Desaturate.** Saturated hues that read as confident on white vibrate on near-black. Dark-theme accents generally want lower chroma and higher lightness than their light counterparts.
- **Elevation reverses.** Shadows work by darkening what is behind them, so on a dark surface they do almost nothing. Dark themes convey height with **lighter** surfaces — the higher the layer, the more it is tinted toward white. `layering.md` covers this as the layering half of the same fact; shipping one shadow ladder for both themes flattens every surface in dark.
- **Re-check contrast in both themes.** A pair that clears 4.5:1 on white frequently fails on `#0f0f0f`, because contrast is measured against the surface and the surface moved. Both directions need checking — `design:systems-lint` checks the pair a `DESIGN.md` declares, which is the light one.
- **Categorical palettes must be re-validated per theme**, not flipped. `data-visualization.md` carries the thresholds.

## Token layering: reference, system, component

Three levels, each referring only to the one above it. This is what makes
a theme swap a change to one layer instead of a search across the file.

| Level | Names | Themed? |
|---|---|---|
| **Reference** | `--blue-500`, `--gray-900` — raw values, named by hue | No. Fixed across themes |
| **System** | `--surface`, `--fg`, `--accent`, `--muted` — named by role | **Yes.** This is the only layer a theme redefines |
| **Component** | `--card-bg: var(--surface)` — named by use | No. Inherits whatever the system layer resolves to |

The rule `color.md` states as "name tokens by purpose, never by hue"
is the reference→system boundary. A component reaching past the system
layer to a reference token (`--card-bg: var(--blue-500)`) is the failure
mode: that card is now the same blue in both themes.

## `prefers-contrast` and forced colors

Two related preferences, distinct from theme and from each other:

- `@media (prefers-contrast: more)` — the viewer asked for higher contrast. Strengthen borders and ink; do not merely swap theme.
- `@media (forced-colors: active)` — Windows High Contrast Mode. The UA **replaces your palette wholesale** with system colors. Your tokens are simply not in effect, so a theme that carries meaning in color alone conveys nothing. Test that borders and focus rings survive, since backgrounds and shadows will not.

Forced-colors is a genuinely separate mode with its own token vocabulary
and its own rules; it is not a third theme and this file does not cover
it beyond the warning above.

## Common mistakes (lint these)

- A palette defined only under `[data-theme]` blocks, so the default system state renders unstyled. This is the single most common theming bug.
- A dark media block without the `:not([data-theme="light"])` guard, so an explicit light choice loses on an OS-dark machine.
- A token whose only definition lives inside a media query or attribute block.
- `color-scheme` never declared — white scrollbars and light form controls on a dark page.
- `body` with no explicit background token, borrowing the host's.
- Dark mode produced with `filter: invert()`, or by algorithmically inverting lightness.
- Light-theme saturation carried unchanged into dark, where it vibrates.
- One shadow ladder reused for both themes, flattening every dark surface.
- Contrast checked in light only. The surface moved; the ratios moved with it.
- A component token pointing at a reference token, so it stays one fixed hue in both themes.
- A dark block that redeclares every token rather than the ones that change.
- `prefers-contrast: more` treated as a synonym for dark mode.
