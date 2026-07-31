# Implementation Plan (operator-authored, blind research: orca vs xx-stack)

- [ ] Read this repo's overlapping surfaces first and write section 1 with real file/symbol citations
  - verify: test -f RESEARCH-orca.md
  - files: xx-stack/mcp-server/src, hermes-orchestration
- [ ] Study stablyai/orca and write section 2: at least five ranked recommendations, each with goal, fit, files, acceptance criteria, effort and risk
  - verify: grep -c "Effort" RESEARCH-orca.md
  - files: RESEARCH-orca.md
- [ ] Write section 3 (at least three explicit rejections with reasons) and mark every upstream claim [read their code] or [from their docs]
  - verify: grep -q "NOT borrowing" RESEARCH-orca.md
  - files: RESEARCH-orca.md
- [ ] Confirm exactly one file added and nothing else changed
  - verify: test -f RESEARCH-orca.md
  - files: RESEARCH-orca.md
