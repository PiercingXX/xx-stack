# Design System Inspired by Fixture Low Contrast

> FIXTURE — authored in this repository for scripts/lint-design-systems.mjs.
> DELIBERATELY BROKEN. Do not "fix" it: the gate proves it can still catch the
> upstream generator defect (a dark theme keeping a light-theme Text default)
> only because this file reproduces it. Structure and extraction are valid; the
> single defect is the declared Text/Surface pair, at 1.06:1 against a 4.5:1
> requirement.

## 1. Visual Theme & Atmosphere

A dark theme that kept a light theme's Text token.

- **Visual style:** dark
- **Color stance:** primary, surface, text
- **Design intent:** Fail the declared-pair contrast check and nothing else.

## 2. Color

- **Primary:** `#0077BC` — Token from style foundations.
- **Surface:** `#111111` — Token from style foundations.
- **Text:** `#111827` — Token from style foundations.
- **Neutral:** `#111111` — Derived from the surface token.

- Favor Primary (#0077BC) for CTA emphasis.
- Use Surface (#111111) for large backgrounds and cards.
- Keep body copy on Text (#111827) for legibility.

## 3. Typography

- **Scale:** 12/14/16/20/24/32

## 4. Spacing & Grid

- **Spacing scale:** 4/8/12/16/24/32

## 5. Layout & Composition

- Prefer clear content blocks with consistent internal padding.

## 6. Components

- Buttons: primary action uses `#0077BC`.

## 7. Motion & Interaction

- Default to short, purposeful transitions (150–250ms).

## 8. Voice & Brand

- Keep microcopy action-oriented.

## 9. Anti-patterns

- Do not add decorative effects that reduce readability or accessibility.
