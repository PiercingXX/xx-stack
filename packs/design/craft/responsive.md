# Responsive craft rules

Universal rules for making one artifact work at every width it will
actually be opened at. The active `DESIGN.md` decides how a brand looks;
this file decides whether that look survives contact with a 375px screen.

> Grounded in: CSS Containment Level 3 (container queries), CSS Values 4
> (`clamp()`, `min()`, `max()`), CSS Grid Level 1 auto-placement, WCAG 2.2
> SC 1.4.10 Reflow (AA) and 1.4.4 Resize Text (AA), and the CSSWG's
> `dvh`/`svh`/`lvh` viewport units.

## The gate already checks for this

`scripts/quality-gate-html.mjs` warns when an artifact contains no
`@media` query at all: *"No @media query found; verify responsive
behavior."* That check shipped without a rulebook behind it, so the
warning told an agent it had a problem and nothing told it what correct
looked like. This file is the missing half.

Note the gate's limit: it detects the **absence** of any query. It cannot
tell a considered breakpoint from a decorative one, so a single unused
`@media (min-width: 768px)` silences it. Passing the gate is not evidence
of responsive behaviour.

## Reflow is a legal floor, not a preference

WCAG 2.2 **1.4.10 Reflow** is Level AA: content must reflow without
requiring scrolling in **two** directions at 320 CSS px wide (equivalent
to 400% zoom on a 1280px viewport). Horizontal scrolling of the page as a
whole is a conformance failure.

The exception is narrow and specific: content requiring two-dimensional
layout **for its meaning** — data tables, maps, diagrams, code. Those may
scroll horizontally **inside their own container**. The page body must not.

**1.4.4 Resize Text** (AA) additionally requires text to survive 200%
resize without loss of content or function. Any fixed-height box holding
text is a candidate failure; `height` on a text container is almost always
wrong, and `min-height` is almost always what was meant.

## Mobile-first, and what that actually means

Write the narrow layout as the unconditional base, then add width with
`min-width` queries.

```css
/* base — narrow, no query */
.grid { display: grid; gap: 1rem; }

/* enhancement */
@media (min-width: 48rem) {
  .grid { grid-template-columns: repeat(2, 1fr); }
}
```

This is not stylistic. Desktop-first (`max-width` queries) means the
narrow case is a pile of overrides, and every new component starts life
broken on the smallest screen and gets patched. Mobile-first means the
smallest screen is the one that works by default.

Use **rem** for breakpoints, not px, so the layout responds to a user's
root font-size preference. `48rem` is 768px at default settings and
correctly becomes wider when someone has enlarged their text.

## Pick breakpoints from the content

Do not copy a device table. Devices change; the point where *your* layout
breaks does not.

Widen the viewport until something looks wrong — a line gets too long, a
card gets too narrow, a nav wraps badly — and put a breakpoint there.
Three or four is typical for one artifact. Ten means the layout is being
micro-managed rather than designed.

As a sanity check rather than a prescription, most artifacts need a
small/medium/large split somewhere near 40rem / 48rem / 64rem, plus a
`max-width` on the reading column. See `typography.md` on line length:
the 60–75 character measure is what actually sets the upper bound, and a
container that keeps growing past it is a typography bug expressed as a
layout one.

## Container queries for components

A media query asks how wide the **viewport** is. A component does not care
— it cares how wide **it** is. A card in a sidebar and the same card in a
main column want different internal layouts at the same viewport width,
and no media query can express that.

```css
.card-region { container-type: inline-size; }

@container (min-width: 30rem) {
  .card { grid-template-columns: auto 1fr; }
}
```

Rule of thumb: **media queries for page structure, container queries for
components.** A component styled by viewport width is one that cannot be
reused in a narrower slot, which is exactly the reuse a component exists
for.

## Fluid sizing, and its two traps

`clamp(MIN, PREFERRED, MAX)` removes most breakpoints from type and
spacing:

```css
h1 { font-size: clamp(1.75rem, 1.2rem + 2.5vw, 3rem); }
```

Two things go wrong with it.

- **A viewport-only preferred value breaks zoom.** `clamp(1rem, 4vw, 2rem)` ignores the user's font-size entirely, because `vw` does not respond to it — a 1.4.4 failure. Always keep a `rem` term in the preferred value, as above.
- **Clamping the body text is usually wrong.** Fluid type is for display sizes. Body copy should be a fixed `rem` value the user's own settings scale; making it fluid means the reader's preference is partly overridden by their window size.

## Tables, charts and other 2D content

These are the reflow exception, and handling them is the most commonly
skipped part of a responsive pass.

- **Wrap, don't squeeze.** Put the table or chart in its own `overflow-x: auto` container. The page body stays put; the wide thing scrolls inside its box.
- **Give the scroll container an accessible name and keyboard access**: `tabindex="0"` and `role="region"` with an `aria-label`, so a keyboard user can reach the scroll.
- **A card list is often the better narrow form** for a table with few columns — each row becomes a stacked block with its headers as labels. This costs markup and is worth it for the two or three tables a reader actually needs on a phone.
- **Charts do not shrink well.** Below roughly 30rem, a multi-series chart is usually better as its table view. See `data-visualization.md` — the table view is already required there for another reason.

## Touch, pointer and the input assumption

Width does not tell you the input device. A 1400px touchscreen and a
900px trackpad laptop both exist.

- Query the input, not the width: `@media (pointer: coarse)` and `(hover: hover)`.
- **Never put essential information behind hover alone.** A touch device has no hover state, so a tooltip-only label is invisible there — and `accessibility-baseline.md` already requires that content be reachable by keyboard, which is the same failure from another direction.
- Touch targets: the AA floor is **24×24 CSS px** (2.5.8), the craft commitment is 44×44. At narrow widths the spacing exception is the one that usually applies — the full rule is in `accessibility-baseline.md`, and this file does not restate it.

## Viewport units and mobile browser chrome

`100vh` is larger than the visible area on mobile browsers whose toolbar
retracts, which is why full-height sections get clipped there.

- `dvh` — dynamic, tracks the chrome as it moves. Right for a full-height hero.
- `svh` — small, assumes chrome present. Right when content must never be clipped.
- `lvh` — large, assumes chrome retracted.

Keep `vh` as a fallback declaration underneath for older engines, then
override with `dvh`.

## Common mistakes (lint these)

- No `<meta name="viewport" content="width=device-width, initial-scale=1">`. The gate checks this one; without it a mobile browser renders at ~980px and scales down, and every other rule here is moot.
- `user-scalable=no` or `maximum-scale=1` on that tag. Blocks pinch-zoom; fails 1.4.4.
- Horizontal scroll on the page body at 320px. Fails 1.4.10 at AA.
- A wide table or chart left to widen the page instead of scrolling inside its own container.
- Desktop-first `max-width` queries, so every component starts broken on mobile and gets patched back.
- Breakpoints in `px`, so the layout ignores the user's root font-size.
- Breakpoints copied from a device list rather than found by widening until the layout breaks.
- Component layout driven by viewport width where a container query was meant — the component then cannot be reused in a narrower slot.
- `clamp()` with a viewport-only preferred value (`4vw` with no `rem` term). Ignores user font-size; fails 1.4.4.
- Fluid `clamp()` on body copy. Display sizes only.
- Fixed `height` on a box containing text. Almost always `min-height`.
- `100vh` on a mobile full-height section, clipped by browser chrome. Use `dvh`/`svh`.
- Essential content or controls behind `:hover` only, unreachable on touch.
- A single decorative `@media` block added to silence the gate. The gate detects absence, not thought.
