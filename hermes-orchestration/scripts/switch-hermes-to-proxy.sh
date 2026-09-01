#!/usr/bin/env bash
# Point the Hermes *client* at the xx-stack loopback proxy (http://127.0.0.1:8180/v1).
#
# Default is dry-run. Never writes ~/.hermes/config.yaml unless --apply is
# passed, and --apply always writes a timestamped backup first.
#
# The live Hermes default on this machine is often a custom OpenAI-compatible
# URL (not the proxy). Overwriting that unattended would silently change which
# backend interactive chat hits.
set -euo pipefail

HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
PROXY_BASE_URL="${HERMES_PROXY_BASE_URL:-http://127.0.0.1:8180/v1}"
APPLY=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--apply] [--config PATH] [--base-url URL]

  --apply        write the change (default: print the planned edit and exit 0)
  --config PATH  Hermes client config (default: ~/.hermes/config.yaml)
  --base-url URL proxy chat/completions root (default: http://127.0.0.1:8180/v1)

Backup path on --apply: <config>.bak.<UTC-timestamp>
Rollback: cp <backup> <config>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --config) HERMES_CONFIG="$2"; shift 2 ;;
    --base-url) PROXY_BASE_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$HERMES_CONFIG" ]]; then
  echo "missing Hermes config: $HERMES_CONFIG" >&2
  echo "Create one first, or pass --config. Refusing to invent a profile." >&2
  exit 1
fi

current_base="$(
  python3 - "$HERMES_CONFIG" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"(?m)^(\s*base_url\s*:\s*)(\S+)\s*$", text)
print(match.group(2) if match else "")
PY
)"

echo "config:     $HERMES_CONFIG"
echo "current:    ${current_base:-<no base_url line>}"
echo "proposed:   $PROXY_BASE_URL"

if [[ "$current_base" == "$PROXY_BASE_URL" ]]; then
  echo "already pointing at the proxy; nothing to do"
  exit 0
fi

if [[ "$APPLY" -eq 0 ]]; then
  echo "dry-run (pass --apply to write a backup and the new base_url)"
  echo "also set provider: custom if it is not already — the proxy is OpenAI-compatible chat/completions"
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${HERMES_CONFIG}.bak.${timestamp}"
cp -a "$HERMES_CONFIG" "$backup"

python3 - "$HERMES_CONFIG" "$PROXY_BASE_URL" <<'PY'
import re, sys
path, url = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
pattern = re.compile(r"(?m)^(\s*base_url\s*:\s*)(\S+)\s*$")
if pattern.search(text):
    text = pattern.sub(rf"\1{url}", text, count=1)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += f"base_url: {url}\n"
open(path, "w", encoding="utf-8").write(text)
PY

echo "wrote:      $HERMES_CONFIG"
echo "backup:     $backup"
echo "rollback:   cp $backup $HERMES_CONFIG"
echo "start the proxy first: python3 hermes-orchestration/scripts/hermes_orchestrator.py serve"
