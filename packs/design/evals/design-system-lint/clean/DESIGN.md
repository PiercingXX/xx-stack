# Design System Inspired by Fixture Clean

> FIXTURE — authored in this repository for scripts/lint-design-systems.mjs.
> Not a design system. Not vendored. Must pass every check in that gate.

## 1. Visual Theme & Atmosphere

A deliberately unremarkable light theme that exercises the Schema-B shape.

- **Visual style:** neutral
- **Color stance:** primary, surface, text
- **Design intent:** Give the linter a file it must accept.

## 2. Color

- **Primary:** `#1D4ED8` — Token from style foundations.
- **Secondary:** `#7C3AED` — Token from style foundations.
- **Success:** `#16A34A` — Token from style foundations.
- **Warning:** `#D97706` — Token from style foundations.
- **Danger:** `#DC2626` — Token from style foundations.
- **Surface:** `#FFFFFF` — Token from style foundations.
- **Text:** `#111827` — Token from style foundations.
- **Neutral:** `#FFFFFF` — Derived from the surface token.

- Favor Primary (#1D4ED8) for CTA emphasis.
- Use Surface (#FFFFFF) for large backgrounds and cards.
- Keep body copy on Text (#111827) for legibility.

## 3. Typography

- **Scale:** 12/14/16/20/24/32
- **Families:** primary=Inter, display=Inter, mono=JetBrains Mono

## 4. Spacing & Grid

- **Spacing scale:** 4/8/12/16/24/32

## 5. Layout & Composition

- Prefer clear content blocks with consistent internal padding.

## 6. Components

- Buttons: primary action uses `#1D4ED8`.

## 7. Motion & Interaction

- Default to short, purposeful transitions (150–250ms).

## 8. Voice & Brand

- Keep microcopy action-oriented.

## 9. Anti-patterns

- Do not introduce off-palette colors when an existing token can solve the problem.
