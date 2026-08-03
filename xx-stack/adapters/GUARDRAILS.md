# Host Adapter Guardrails: Catastrophic-Command Denylist

Every lane's agent enforces one shared denylist of catastrophic shell
patterns.

Source-of-truth rule (same convention as the skill/agent mirrors):

- canonical list: `runtime/dangerous-patterns.txt` — one POSIX-ERE per line,
  `#` comments
- host adapters consume or mirror that file; they never define their own list
- if a mirror and the canonical file differ, fix the mirror — never fork the
  patterns locally
- `opencode-orchestration/opencode/dangerous-patterns.txt` is a symlink to the
  canonical file (checked by `npm run guardrails:check`)

## What the list covers

Only irreversible/catastrophic operations: `rm -rf` on `/`, `~`, `$HOME`, or a
home directory root; recursive deletion of `.git`; `dd`/`mkfs`/`wipefs`/`shred`
onto a block device; fork bombs; piping a `curl`/`wget` download into a shell;
`git push --force`/`-f`; `gh repo delete`.

Destructive-but-recoverable commands stay allowed by design — `git clean`,
`rm -rf node_modules`, `git reset --hard`, `git push --force-with-lease`,
`dd` to an image file. Over-blocking kills agent usefulness; do not add
patterns for recoverable operations.

## How a host adapter enforces it

The MCP server enforces the list in `mcp-server/src/execution_policy.ts` as a
deny layer ahead of its exec allowlist. Host-side (shell) enforcement uses the
same file directly — check the full command line before executing:

```sh
if printf '%s' "$COMMAND_LINE" | grep -E -q -f runtime/dangerous-patterns.txt; then
  echo "blocked: matches dangerous-patterns.txt" >&2
  exit 1
fi
```

Patterns are matched unanchored against the whole command line. The file is
kept to the regex subset valid in both POSIX ERE and JavaScript RegExp, so the
same lines work in `grep -E` and in the server.

## Honest limit

This is a seatbelt against accidents, not a sandbox against a malicious agent.
Quoting, variable indirection, encoding, or a wrapper script can evade any
regex list; real containment requires OS-level sandboxing. Enforcement
fail-open behavior: if the pattern file is missing or a line fails to parse,
the server skips what it cannot use and flags it — a broken list never blocks
everything (and never silently blocks nothing in CI: `npm run
guardrails:check` fails closed on parse errors).

## Changing the list

Any edit to `runtime/dangerous-patterns.txt` must land together with an update
to `scripts/check-dangerous-patterns.mjs` (block/allow cases and the pinned
content hash). `npm run guardrails:check` — part of `npm run verify` — fails
until both move together.
