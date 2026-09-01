# Layering craft rules

Universal rules for what paints on top of what. The active `DESIGN.md`
decides how depth *looks* — shadow softness, surface tint, border weight.
This file decides the thing underneath that: which element actually wins
when two overlap, and why the winner is so often not the one the author
picked.

> Grounded in: CSS Positioned Layout Level 3 (stacking contexts and the
> painting order), the HTML Standard's top layer (`dialog.showModal()`,
> the Popover API), CSS Containment and `isolation`, and MUI's shipped
> `zIndex.js` / `shadows.js`, read from `mui/material-ui` at
> `48c6663a` (2026-08-14, MIT).

## The failure this file exists to prevent

A dropdown renders behind the card below it. The author raises the
dropdown to `z-index: 9999`. It still renders behind. So the next
element gets `999999`, and within a quarter the codebase has no
layering system at all — just an arms race whose largest number wins
until it doesn't.

The escalation never works because **`z-index` is not global**. It is
resolved only against siblings inside the same stacking context. A
child at `z-index: 999999` inside a parent at `z-index: 1` still loses
to that parent's `z-index: 2` sibling, because the whole subtree is
composited as one unit at the parent's level. The number was never the
problem.

Two corollaries an agent gets wrong constantly:

- **`z-index` is inert on `position: static`.** It applies to positioned elements (`relative`, `absolute`, `fixed`, `sticky`) and to flex/grid children. On a plain static `<div>` it does nothing at all, silently.
- **Raising a number is not the fix.** The fix is finding which ancestor created the trapping stacking context, and either removing it or moving the element out of it.

## What creates a stacking context

This is the diagnostic list. When layering misbehaves, walk the
ancestor chain and find the first element matching any of these — that
is the ceiling the element cannot escape.

| Trigger | Note |
|---|---|
| Root `<html>` | The one every page has |
| `position: relative\|absolute` **with** `z-index` ≠ `auto` | The intentional case |
| `position: fixed` or `sticky` | Creates one **regardless of `z-index`** — the most common accidental trap |
| `opacity` < 1 | Includes `opacity: 0.999`, which is why "invisible" fade wrappers break layering |
| `transform`, `filter`, `backdrop-filter`, `perspective`, `clip-path`, `mask` ≠ `none` | Any of them; `transform: translateZ(0)` GPU hacks are the classic offender |
| `mix-blend-mode` ≠ `normal` | |
| `isolation: isolate` | The only one whose *purpose* is to create one |
| `contain: paint \| layout \| content \| strict` | |
| `will-change` naming any property above | Creates the context *before* the property is ever applied |

The pattern in the accidental rows: they are all properties someone
adds for **animation or visual polish**, with no intent to change paint
order. A `transform` added to a card for a hover lift will trap every
tooltip inside that card. This is where `animation-discipline.md` and
this file meet — motion work is the single largest source of layering
regressions.

## Use a named ladder, not literals

Layering is global state in the browser, so it has to be declared in
one place. Scattered literals cannot be reasoned about: nobody can
answer "what is above the app bar?" by grepping for numbers.

MUI's shipped ladder is a good reference shape — nine surfaces, one
file, ordered by how interruptive each is:

| Token | Value |
|---|---|
| `mobileStepper` | 1000 |
| `fab` | 1050 |
| `speedDial` | 1050 |
| `appBar` | 1100 |
| `drawer` | 1200 |
| `modal` | 1300 |
| `snackbar` | 1400 |
| `tooltip` | 1500 |

Three things worth copying, independent of the numbers:

- **Ordered by interruptiveness, not by build order.** Tooltip beats snackbar beats modal beats drawer. A transient thing the user summoned must outrank a persistent thing they didn't.
- **Gaps between rungs.** 100 between most, 50 where two peers sit close. Gaps leave room to insert a surface later without renumbering the ladder.
- **Ties are legal.** `fab` and `speedDial` share 1050 because they are the same surface in two states and never coexist. Forcing a distinction between them would be false precision.

Start at 1000 rather than 1, so third-party widgets that squat on
small numbers sit below the ladder by default.

## Modals belong in the top layer, not the ladder

For genuinely modal surfaces, the correct answer as of 2026 is to stop
competing on `z-index` at all. `dialog.showModal()` and the Popover API
promote an element to the browser's **top layer**, which paints above
the entire document *regardless of stacking contexts*. A trapping
ancestor `transform` cannot hold it down, because the element is no
longer painted as part of that subtree.

This also gets three accessibility behaviours for free that a
hand-rolled `<div role="dialog">` has to reimplement and usually gets
wrong: focus is moved into the dialog and trapped there, `Escape`
dismisses it, and content behind it is inert to both pointer and
assistive technology. `accessibility-baseline.md` treats a modal's
focus trap as correct behaviour rather than a 2.1.2 violation — the
top layer is how you get that behaviour without writing it.

Use `::backdrop` for the scrim. Keep the ladder for the non-modal
surfaces that remain (app bar, drawer, sticky headers).

## Visual depth and paint order are two systems

Material ships 25 elevation steps, each a three-shadow composite —
umbra at 0.2 alpha, penumbra at 0.14, ambient at 0.12 — layered so the
shadow reads as a single light source rather than three separate
blurs. That is a **visual** ladder, and it is independent of the
`z-index` ladder above.

They must agree. An element that looks higher must also paint higher.
A card with elevation 8 sitting behind a card with elevation 2 is a
bug the user perceives as a rendering glitch even though no CSS rule
was violated — the shadow promised one order and the paint delivered
another.

The practical rule: assign elevation and stacking from the same
decision about how interruptive a surface is, not from two independent
passes over the design.

## Dark mode inverts the mechanism

Shadows work by darkening what is behind them, so on a dark surface
they are close to invisible — a `rgba(0,0,0,0.2)` umbra over `#121212`
moves almost nothing. Dark themes convey elevation with **lighter
surfaces** instead: the higher the surface, the more it is tinted
toward white. Material does this with an overlay whose alpha rises
with elevation.

Shipping one shadow ladder for both themes is therefore not a
simplification, it is a dark-mode bug — every surface flattens to the
same plane. Either ship a surface-tint ladder for dark, or accept that
dark mode conveys depth through borders and spacing and design it
that way deliberately.

## Common mistakes (lint these)

- `z-index: 9999` (or any escalating literal) as the fix for an occlusion bug. The trapping ancestor is the bug; the number never was.
- `z-index` on a `position: static` element. Inert, and silently so.
- Assuming `position: fixed`/`sticky` are layering-neutral. Both create a stacking context with no `z-index` present.
- A `transform` or `will-change` added for a hover animation, trapping every tooltip and dropdown inside that subtree.
- `opacity: 0.999` or `translateZ(0)` GPU-nudge hacks, which create stacking contexts as a side effect nobody records.
- Hand-rolled `<div role="dialog">` competing on `z-index` when `dialog.showModal()` would escape the problem entirely and bring focus containment, `Escape`, and background inertness with it.
- Layering literals scattered across component files instead of one named ladder. "What is above the app bar?" must be answerable by reading one file.
- A ladder numbered 1, 2, 3… with no gaps. The first inserted surface forces a renumber.
- Elevation and stacking assigned in two independent passes, so a visually-higher card paints underneath a visually-lower one.
- One shadow ladder reused for dark mode. Shadows darken; on `#121212` they do nothing, and every surface flattens.
- `isolation: isolate` treated as a code smell. It is the one deliberate way to scope a subtree's layering, and it is preferable to a `z-index` bump.
