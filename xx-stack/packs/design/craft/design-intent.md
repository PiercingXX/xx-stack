# Design Intent

> **Authored in xx-stack — this file is not vendored.** The 11 rulebooks in
> `craft/` are byte-identical to `nexu-io/open-design`; this one is written
> here, in our own words, from three arguments made in
> `google-labs-code/design.md`'s `PHILOSOPHY.md` (Apache-2.0, read at commit
> `9bf8eae`). No upstream prose is reproduced and no upstream file is
> redistributed. See `../manifest.json`, source id `design-md`.

The other files in `craft/` tell an agent how to render something once it knows
what it is building. This one is about the step before: how the thing gets
described.

## 1. The prose is the specification. The token values are context.

A token block exists so the prose can name a value instead of repeating it. It
is a glossary, not a set of rendering instructions — upstream says so directly,
and declines to accept token *requirements* in a specification at all.

A hex on its own carries almost nothing: it does not say which surface it
covers, which role it is forbidden from, or what happens to it in a dense
layout. A sentence restricting the accent to diagram annotations, and barring it
from body type and page furniture, is the actual constraint; the hex is only the
thing that sentence points at. Strip the prose and you have a palette, not a
design.

**Why this matters here.** Our 137 design systems are prose-first, and
`scripts/lint-design-systems.mjs` exists to recover a token map out of that
prose. It is easy to read that as the pack being underspecified. Upstream's
argument says the opposite: the prose is the asset, and an extracted token map
is a convenience for gates rather than the specification finally arriving.

**This is a dissent, not a veto.** the repository history task 33 proposes
vendoring per-brand `tokens.css` so a brand becomes a checkable `:root`
contract. That stays mechanically useful — a gate cannot check prose. The two
positions are compatible as long as the `:root` contract is a *verification
surface* rather than the brand's definition, and stop being compatible the
moment an agent is pointed at `tokens.css` instead of `DESIGN.md`. Read this
before actioning task 33. The dissent is also recorded in `../manifest.json`
under the `design-md` source, so it does not depend on anyone re-reading this
file.

## 2. A specific reference carries more than a list of adjectives.

Upstream's example is four words any brief might contain: *modern, clean,
trustworthy, premium*. Each names a region of design space rather than a point
in it. A model asked to satisfy all four lands near the middle of every region
at once — and that centre is exactly the output everyone recognises and nobody
asked for.

A concrete reference behaves differently. Name a printed seminar handout from an
old university and the rest follows unlisted: one ink colour, a serif at reading
size, wide margins, no decoration. One sentence carries more than a dozen
measured values, because it carries the reasoning that produced them.

**This is the missing *why* behind `anti-ai-slop-rules.json`.** That file
encodes 18 mechanically checkable rules — `purple-gradient`, `ai-default-indigo`,
`invented-metric`, `emoji-icon`, `filler-copy` — with no stated theory of where
any of it comes from. This is the theory: each of
those 18 is a catalogued symptom of a model landing in the centre of an
adjective cloud. They are the regional average, written down.

That does not make the rules redundant — slop appears under specific briefs too,
and a rule that fails a build beats a principle that does not. It sets the order
of operations. The rule table catches the symptom; a specific reference removes
the cause. Reaching for the table to compensate for a vague brief is treating
the wrong end.

## 3. Negative constraints arrive for free when the reference is specific.

Naming an object imports its exclusions along with its properties. A model that
knows what a printed handout is also knows what one is not: it does not glow, it
has no gradient mesh, no hero image above the title. None of that needs writing
down.

The use of this is diagnostic, and it runs in the unexpected direction. A short,
deliberate list of don'ts is a good sign — it names the few genuinely ambiguous
calls. A long rambling one signals that the description upstream of it was too
vague to carry its own restrictions, and the list is doing work the reference
should have done. **When the don't list grows, fix the reference, not the
list.**

Applied here: when a design system's *Do's and Don'ts* or *Anti-patterns*
section runs long, read it as evidence about that file's *Visual Theme &
Atmosphere* section rather than as a bigger checklist to enforce. Same for
`workflow-skills/*/references/checklist.md`.

## What this file is not

Doctrine, not a checkable rulebook. Nothing here produces a P0/P1/P2 finding and
no gate reads it. It resolves as an `od.craft.requires` slug (`design-intent`)
so a skill *can* pull it in, but no skill binds it: every binding in this pack
is upstream's, transcribed unchanged, and inventing one for a file upstream does
not have would break that rule. See `XX-STACK-NOTES.md`.
