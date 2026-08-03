---
name: planning
description: Compatibility alias for plan tasks that reference the legacy 'planning' agent type. Delegates to plan agent behavior.
mode: subagent
temperature: 0.1
steps: 12
permission:
  edit: deny
  bash: allow
  skill:
    "*": allow
---

# Planning Agent

This agent is a **compatibility alias** for `plan`. It accepts tasks using the legacy `planning` agent name and behaves identically to the `plan` agent.

Read `runtime/agents/plan.md` for the full operating spec and workflow protocol.

## Routing

If invoked directly by a user, delegate to the `plan` agent workflow:
1. Receive the task description
2. Follow the full plan agent protocol from `runtime/agents/plan.md`
3. Produce an executable plan package in the same format

Do not produce a simplified or abbreviated plan. Use the full plan agent workflow.

The alias inherits `plan`'s rule book, not only its steps: read `packs/rules/the-pragmatic-programmer/the-pragmatic-programmer.mini.md` before Phase 3 (Structure) and decompose against it. ~1,800 tokens on tracer bullets and orthogonality — skipping it is how an alias quietly returns a weaker plan than the agent it aliases.
