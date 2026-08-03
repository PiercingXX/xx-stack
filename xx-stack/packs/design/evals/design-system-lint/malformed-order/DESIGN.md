# Design System Inspired by Fixture Malformed Order

> FIXTURE — authored in this repository for scripts/lint-design-systems.mjs.
> DELIBERATELY BROKEN. Do not "fix" it. Components is placed BEFORE Color, which
> is legal in neither shipped schema (Schema A orders Components→Layout, Schema B
> orders Layout→Components, but both put Color second). Contrast and extraction
> are clean here so the structural failure is isolated.

## 1. Visual Theme & Atmosphere

Sections in an order neither lineage uses.

- **Visual style:** neutral

## 2. Components

- Buttons: primary action uses `#1D4ED8`.

## 3. Color

- **Primary:** `#1D4ED8` — Token from style foundations.
- **Surface:** `#FFFFFF` — Token from style foundations.
- **Text:** `#111827` — Token from style foundations.

- Favor Primary (#1D4ED8) for CTA emphasis.
- Use Surface (#FFFFFF) for large backgrounds and cards.
- Keep body copy on Text (#111827) for legibility.

## 4. Typography

- **Scale:** 12/14/16/20/24/32

## 5. Spacing & Grid

- **Spacing scale:** 4/8/12/16/24/32

## 6. Layout & Composition

- Prefer clear content blocks with consistent internal padding.

## 7. Motion & Interaction

- Default to short, purposeful transitions (150–250ms).

## 8. Voice & Brand

- Keep microcopy action-oriented.

## 9. Anti-patterns

- Do not flatten hierarchy by using the same type size/weight for all text.
