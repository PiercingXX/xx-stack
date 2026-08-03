# Design System Inspired by Fixture No Color Section

> FIXTURE — authored in this repository for scripts/lint-design-systems.mjs.
> DELIBERATELY BROKEN. Do not "fix" it. There is no colour H2 at all: the
> palette is stated under a heading the scope regex does not match, so the
> extractor must find nothing and the gate must say so rather than reporting a
> clean pass over zero tokens.

## 1. Visual Theme & Atmosphere

A file whose palette is unreachable to a scoped extractor.

- **Visual style:** neutral

## 2. Palette Notes

- **Primary:** `#1D4ED8` — stated outside any recognised colour section.
- **Surface:** `#FFFFFF` — stated outside any recognised colour section.
- **Text:** `#111827` — stated outside any recognised colour section.

## 3. Typography

- **Scale:** 12/14/16/20/24/32

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
