---
name: diagnose-stack
description: Stack health check. Verifies MCP server, agent definitions, skill structure, environment variables, and config wiring.
compatibility: opencode
metadata:
  source: xx-stack
---

# Diagnose Stack

You are a stack diagnostician.

## Goal

Run a systematic health check on the xx-stack installation and report findings with pass/fail status per check.

Use the runtime-status model from `shared_instructions.md`: check the actual active surface, report drift plainly, and distinguish `PASS`, `WARN`, and `FAIL`.

## Checks

### 1. MCP server

```
 Run `npm run layout:verify` from the repository root and confirm all layout checks pass.
```

### 2. Agent definitions

```
- Does opencode/config.json exist and parse as valid JSON?
- For each agent listed in config.json, does the corresponding agents/<name>.md file exist?
- Does each agent .md have valid YAML frontmatter (name, description, model)?
- Does shared_instructions.md exist at opencode/shared_instructions.md?
- If aliases are referenced, do they resolve to documented canonical agents?
```

### 3. Skill structure

```
- For each folder under opencode/skills/, does a SKILL.md exist?
- Does each SKILL.md have valid YAML frontmatter (name, description, compatibility)?
- Are all skills listed in opencode/SKILLS.md actually present on disk?
- If the OpenCode copy is present, does `npm run drift:check` pass?
```

### 4. Environment and configuration

```
- Is opencode/platforms.json present and valid JSON?
- Is opencode/FILE-STRUCTURE.md present?
- Is README.md present at repo root?
- Check for any internal cross-references to deleted files (e.g., grep for AGENTS.md references).
- If `.xxignore` exists, is it syntactically coherent and aligned with `.gitignore`-style intent?
- If `hooks/` exists, are documented hook scripts present and referenced consistently?
```

### 5. Install wiring

```
- Does setup-opencode.sh exist and is it executable?
- Is the MCP server built (`mcp-server/dist/index.js`) and referenced from the host config?
```

### 6. Runtime status contract

```
- Report config/source precedence assumptions used during diagnosis.
- Report agent shadowing or alias resolution status.
- Report skill shadowing or mirror drift status.
- Report hook surface status: absent, documented-only, or wired.
- Report ignore-surface status: `.xxignore`, `.gitignore`, or no explicit repo-local exclusion layer.
```

## Output Format

Report each check as a table row:

| Check | Status | Detail |
|---|---|---|
| MCP server build | PASS | Built cleanly |
| Agent definitions | PASS | 10/10 files found |
| Skill structure | WARN | ops-canary mirror drift detected |
| Environment | FAIL | platforms.json not found |
| Install wiring | PASS | setup-opencode.sh executable, MCP built |
| Hook surface | WARN | Documented, but no live hook runtime found |
| Ignore surface | PASS | Falling back to .gitignore |

After the table, include:

1. `Precedence Assumptions` — what source-of-truth order was used.
2. `Shadowing And Drift` — any agent/skill mirror mismatches.
3. `Failures And Warnings` — each with actionable remediation.

## Completion Criteria

- Every check has a status.
- Every runtime-status assumption is explicit.
- All failures include a remediation step.
- End with a summary: `N checks passed, N warnings, N failures.`
