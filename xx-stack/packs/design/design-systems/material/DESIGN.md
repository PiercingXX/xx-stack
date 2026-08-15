# Design System Inspired by Material

> Category: Professional & Corporate
> Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns.

## 1. Visual Theme & Atmosphere

Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns.

- **Visual style:** modern, minimal, clean
- **Color stance:** primary, secondary, neutral, success, warning, danger
- **Design intent:** Keep outputs recognizable to this style family while preserving usability and readability.

## 2. Color

- **Primary:** `#1976D2` — `palette.primary.main`, light mode (blue[700]). Dark mode uses blue[200] `#90CAF9`.
- **Secondary:** `#9C27B0` — `palette.secondary.main`, light mode (purple[500]).
- **Success:** `#2E7D32` — `palette.success.main`, light mode (green[800]).
- **Warning:** `#ED6C02` — `palette.warning.main`. Not a palette ramp value: MUI's source comments it "closest to orange[800] that pass 3:1".
- **Danger:** `#D32F2F` — `palette.error.main`, light mode (red[700]).
- **Surface:** `#FFFFFF` — `palette.background.default` / `.paper`, light mode. Dark mode is `#121212` for both.
- **Text:** `#212121` — `palette.text.primary` is `rgba(0, 0, 0, 0.87)`; composited on the white surface that is exactly `#212121`, which is also grey[900].
- **Neutral:** `#FFFFFF` — Derived from the surface token for official format compatibility.

Info is the sixth semantic role and has no slot in this schema: `palette.info.main` is `#0288D1` (lightBlue[700]).

- Favor Primary (#1976D2) for CTA emphasis.
- Use Surface (#FFFFFF) for large backgrounds and cards.
- Keep body copy on Text (#212121) for legibility.

## 3. Typography

- **Scale:** 96/60/48/34/24/20/16/14/12 — h1 through caption. Each step is a named variant, not a free ramp; pick the variant, don't interpolate.
- **Families:** primary=Roboto, display=Roboto, mono=Roboto Mono. The full default stack is `"Roboto", "Helvetica", "Arial", sans-serif`.
- **Weights:** 300 (light), 400 (regular), 500 (medium), 700 (bold). Material ships four, not nine — 500 is the button/h6/subtitle2 weight and carries most of the emphasis work.
- Each variant carries its own line-height and letter-spacing; they are part of the token, not defaults to re-derive:

| Variant | Size | Weight | Line-height | Letter-spacing |
|---|---|---|---|---|
| h1 | 96 | 300 | 1.167 | -0.01562em |
| h2 | 60 | 300 | 1.2 | -0.00833em |
| h3 | 48 | 400 | 1.167 | 0em |
| h4 | 34 | 400 | 1.235 | 0.00735em |
| h5 | 24 | 400 | 1.334 | 0em |
| h6 | 20 | 500 | 1.6 | 0.0075em |
| subtitle1 | 16 | 400 | 1.75 | 0.00938em |
| subtitle2 | 14 | 500 | 1.57 | 0.00714em |
| body1 | 16 | 400 | 1.5 | 0.00938em |
| body2 | 14 | 400 | 1.43 | 0.01071em |
| button | 14 | 500 | 1.75 | 0.02857em, uppercase |
| caption | 12 | 400 | 1.66 | 0.03333em |
| overline | 12 | 400 | 2.66 | 0.08333em, uppercase |

- Base body size is 14px, not 16px — `typography.fontSize` is 14 while `htmlFontSize` stays 16, so `pxToRem` scales by 14/16. Sizes above are px before that conversion.
- The letter-spacing values were designed for Roboto specifically. MUI drops them entirely when `fontFamily` is overridden, because reusing Roboto's kerning on another face degrades it. If you substitute a font, drop the tracking too.
- `button` and `overline` are uppercase. See `craft/typography.md` — ALL CAPS needs ≥0.06em tracking, and `button` at 0.02857em is below that bar; Material's own value is not a licence to ignore it.
- Headings should carry the style personality; body text should optimize scanability and contrast.

## 4. Spacing & Grid

- **Spacing scale:** 8/16/24/32/40/48 — a single 8px base unit multiplied, not a hand-picked ramp. `spacing(1)` is 8px; fractions are legal, so `spacing(0.5)` gives the 4px used for tight inset padding.
- **Radius:** 4px (`shape.borderRadius`), one value for the whole system.
- **Breakpoints:** xs 0 / sm 600 / md 900 / lg 1200 / xl 1536 px, mobile-first. `down()` queries subtract 0.05px rather than 1px, so ranges never overlap or leave a gap.
- Keep vertical rhythm consistent across sections and components.
- Align columns and modules to a predictable grid; avoid ad-hoc offsets.

## 5. Layout & Composition

- Prefer clear content blocks with consistent internal padding.
- Keep hierarchy obvious: headline → support text → primary action.
- Use whitespace to separate concerns before adding borders or shadows.

## 6. Components

- Buttons: primary action uses `#1976D2`; secondary actions stay neutral.
- Inputs: strong focus-visible states, clear labels, and predictable error messaging.
- Cards/sections: use consistent radii, spacing, and elevation strategy across the page.

## 7. Motion & Interaction

- Use subtle transitions that emphasize Primary (#1976D2) as the interaction signal.
- **Durations:** shortest 150 / shorter 200 / short 250 / standard 300 / complex 375 ms; entering 225 ms, leaving 195 ms. Asymmetry is deliberate — things leave faster than they arrive.
- **Easing:** standard `cubic-bezier(0.4, 0, 0.2, 1)`; decelerate (enter) `cubic-bezier(0.0, 0, 0.2, 1)`; accelerate (exit) `cubic-bezier(0.4, 0, 1, 1)`; sharp `cubic-bezier(0.4, 0, 0.6, 1)` for objects that may return to screen.
- These are **Material 2** motion tokens, which is what MUI ships and what its source cites. Material 3's standard easing is `cubic-bezier(0.2, 0, 0, 1)`, and M3 keeps the curve above under the name `legacy`. Do not label these M3 — `craft/animation-discipline.md` lints exactly that mistake.
- Interaction state opacities are tokens too: hover 0.04, selected 0.08, focus 0.12, disabled 0.38 (light mode). Dark mode raises hover to 0.08 and selected to 0.16, because the same overlay reads weaker on a dark surface.
- Ensure hover, focus-visible, active, disabled, and loading states are explicit.

## 8. Voice & Brand

- Tone should reflect the visual style: concise, confident, and product-specific.
- Keep microcopy action-oriented and avoid generic filler language.
- Preserve the style identity in headlines while keeping UI labels literal and clear.

## 9. Anti-patterns

- Do not introduce off-palette colors when an existing token can solve the problem.
- Do not flatten hierarchy by using the same type size/weight for all text.
- Do not add decorative effects that reduce readability or accessibility.
- Do not mix unrelated visual metaphors in the same interface.
