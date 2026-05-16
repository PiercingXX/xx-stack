---
name: researcher
description: Compatibility alias for research tasks that reference the legacy 'researcher' agent type. Delegates to research agent behavior.
mode: subagent
temperature: 0.1
steps: 12
permission:
  edit: deny
  bash: allow
  skill:
    "*": allow
---

# Researcher Agent

This agent is a **compatibility alias** for `research`. It accepts tasks using the legacy `researcher` agent name and behaves identically to the `research` agent.

Read `runtime/agents/research.md` for the full operating spec and workflow protocol.

## Routing

If invoked directly by a user, follow the full research agent protocol from `runtime/agents/research.md`. Do not abbreviate — produce the full structured findings output.
