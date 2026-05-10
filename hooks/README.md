# Local Hook Scaffolding

This directory is the repo-local scaffolding surface for host runtimes that support automation hooks.

xx-stack does not assume a global hook runner exists. Treat this directory as:

- the canonical place to document repo-local hook behavior
- the default location for reusable hook scripts
- an optional surface that degrades safely when the host runtime has no hook support

## Supported Hook Intents

- session start or end context setup
- pre-tool policy checks
- post-tool verification or logging
- pre-compaction archival or summary capture
- delegated-agent start or stop bookkeeping

## Authoring Rules

1. Keep hooks deterministic and safe to re-run.
2. Prefer local shell or small scripts over external services.
3. Document trigger, inputs, timeout, outputs, and blocking behavior.
4. Never silently rewrite project state.
5. If the host runtime lacks hooks, use these scripts as manual helpers instead of inventing automation.

## Layout

- `hooks/examples/` contains starter scripts you can adapt.
- Keep production hook scripts small and task-specific.

## Suggested Wiring

When a runtime supports hooks, wire scripts from this directory rather than scattering them across the repo.

Example intent mapping:

- `hooks/examples/pre-tool-policy.sh` -> pre-tool validation or denylist checks
- `hooks/examples/post-tool-verify.sh` -> post-edit verification reminders or logging

## Example Host Wiring

Example VT Code-style lifecycle wiring:

```toml
[hooks.lifecycle]
pre_tool_use = [
	{
		matcher = "Bash",
		hooks = [
			{ command = "$VT_PROJECT_DIR/hooks/examples/pre-tool-policy.sh", timeout_seconds = 5 }
		]
	}
]

post_tool_use = [
	{
		matcher = "Write|Edit",
		hooks = [
			{ command = "$VT_PROJECT_DIR/hooks/examples/post-tool-verify.sh", timeout_seconds = 5 }
		]
	}
]
```

Use this only in runtimes that actually support lifecycle hooks. In other hosts, run the scripts manually or treat them as reference implementations.

## Status

Current repo status: documented scaffolding only. No host-specific hook runtime is enforced by xx-stack.