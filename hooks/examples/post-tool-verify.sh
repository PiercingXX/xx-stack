#!/usr/bin/env bash

set -eu

# Example post-tool verification hook.
#
# Expected input: a JSON payload on stdin from a host runtime that supports
# post-tool hooks. This starter emits a reminder message and exits cleanly.

cat >/dev/null
echo "Post-tool reminder: run the narrowest deterministic verification check for the changed surface."