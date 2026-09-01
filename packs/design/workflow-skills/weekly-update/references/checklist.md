# Quality Checklist

## P0 — Must pass before emitting

- [ ] Design system tokens mapped to CSS `:root` custom properties
- [ ] Template HTML read and used as structural starting point
- [ ] No invented brand colors — all from DESIGN.md
- [ ] All placeholder metrics labelled with `—` (en-dash), never fabricated numbers
- [ ] HTML is self-contained (inline CSS + JS, no external dependencies)
- [ ] No forbidden anti-patterns present (see design-prototype SKILL.md)
- [ ] **No production control was rendered as content.** Re-read every headline, eyebrow, item label, metric caption, table cell, `alt` string and slide label and ask: does this describe the deck, or the week? Instructions from the brief about charts, layout, styling, positioning or slide order are production controls — they choose the markup and are then spent. A slide titled "make the metrics slide a bar chart" is the exact failure this line exists to catch.
- [ ] **Layout matches the shape of the content.** A numeric series → the inline chart on the metrics slide; text rows → a table or list, never a chart; a table of contents layout only when the content really is a table of contents. If the brief supplied no image, no image frame appears.
- [ ] **Speaker notes, if present, are plain text.** No markdown — a notes pane renders `**bold**` and `- ` literally.

## P1 — Must pass before declaring complete

- [ ] Self-critique score ≥ 3/5 across all 5 dimensions
- [ ] Visual hierarchy readable in 3 seconds
- [ ] Consistent spacing/weight/color throughout
- [ ] Mobile-responsive if web surface
- [ ] Font families match DESIGN.md typography spec

## P2 — Nice to have

- [ ] Dark mode variant provided
- [ ] Interaction states (hover, focus, active) defined
- [ ] Animation/transition present if motion would add value
- [ ] Accessibility: sufficient contrast, semantic HTML, ARIA labels where needed
