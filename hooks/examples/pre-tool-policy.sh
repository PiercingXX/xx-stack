#!/usr/bin/env bash

set -eu

# Example pre-tool policy hook.
#
# Expected input: a JSON payload on stdin from a host runtime that supports
# pre-tool hooks. This script is intentionally conservative and acts as a
# reusable starter, not an enforced repo policy.
#
# WARNING: this substring denylist is bypassable (flag reordering, whitespace
# padding, matches inside Write-tool file bodies); execution_policy.ts in
# mcp-server/src/ is the enforced gate.

payload="$(cat)"

case "$payload" in
  *"git push --force"*|*"rm -rf /"*)
    echo "Blocked by repo-local pre-tool policy example" >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac