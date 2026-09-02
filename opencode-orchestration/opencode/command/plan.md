---
description: Produce an executable plan package without editing files
agent: plan
---

Stay in plan mode. Do not edit files.

If the request is underspecified, ask at most four blocking questions. Otherwise explore with `research` slices (waves of 3), then write a plan package a `build` agent can execute: slices, blockedBy edges, verification per slice, and an explicit go/no-go.

Load `plan-feature` when this is a product slice, `plan-architecture` when structure is the question, `interrogate-plan` when the user needs one decision at a time.
