# Goal

Review an external repository against THIS one and recommend what is worth
borrowing. Produce a ranked, evidence-backed set of proposals — the same
artefact a senior engineer would write before any code is committed.

The subject: **stablyai/orca** (find it on GitHub). It is an agent
orchestration product; this repo is a headless, local-first MCP control
plane. They overlap in intent and differ in architecture, which is exactly
what makes the comparison useful.

# What to produce

A single file, `RESEARCH-orca.md` at the repo root, containing:

1. **What this repo already has** in the overlapping areas — cite real
   files and symbols you read (path:line or path + symbol name). This
   section is why a reader should trust the rest.
2. **Ranked recommendations**, highest leverage first. For each:
   - Goal, in one or two sentences.
   - Why it fits THIS repo specifically — not why it is nice in general.
   - The files that would change or be created (real paths in this repo).
   - Acceptance criteria a reviewer could check.
   - Effort (S/M/L) and risk (low/med/high), with a one-line reason.
3. **Explicitly NOT borrowing** — at least three things you considered and
   rejected, each with the reason. A review that recommends everything has
   not been done.
4. **Evidence discipline**: mark every upstream claim as either
   `[read their code]` or `[from their docs]`. Never present a docs claim
   as a code claim.

# Hard constraints

- Do NOT modify any code in this repo. This task produces ONE markdown
  file and nothing else.
- The guiding constraint of this repo is non-negotiable and every
  recommendation must respect it: headless, local-first, no GUI, cloud
  opt-in only, `inventory.json` as the single source of truth.
- Recommend nothing you have not seen evidence for. If you cannot read
  their source, say so and mark the claim `[from their docs]`.
- Do not search for or read any pre-existing borrow list, TODO, or
  recommendation file for this repo — from any source, including the web.
  The point of this exercise is YOUR analysis. If you encounter one,
  stop reading it and say so in the file.

# Acceptance criteria

1. `RESEARCH-orca.md` exists at the repo root.
2. It contains all four sections above, with at least five ranked
   recommendations and at least three explicit rejections.
3. Every upstream claim carries `[read their code]` or `[from their docs]`.
4. Every recommendation names real files in this repo that exist.
5. `git status` shows exactly one added file and no other changes.
