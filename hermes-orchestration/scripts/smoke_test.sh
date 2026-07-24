#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

assert_lane() {
  local file_path="$1"
  local expected_lane="$2"
  local check_mode="$3"
  python3 - "$file_path" "$expected_lane" "$check_mode" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
expected = sys.argv[2]
mode = sys.argv[3]
lane = str(payload.get("lane", ""))
selected_models = payload.get("selected_models") or []

if mode == "equals" and lane != expected:
    raise SystemExit(f"expected lane {expected}, got {lane}")
if mode == "not-equals" and lane == expected:
    raise SystemExit(f"expected lane != {expected}, got {lane}")
if lane == "github-premium-cloud" and not any(model in {"gpt-5.3-codex", "gpt-5.4"} for model in selected_models):
    raise SystemExit(f"unexpected premium-cloud selected_models: {selected_models}")
print(json.dumps({"lane": lane, "selected_models": selected_models}, indent=2))
PY
}

echo "[1/6] Unit tests"
python3 -m unittest discover -s tests

echo "[2/6] Cloud CLI preflight"
HERMES_AVAILABLE=1
if ! command -v hermes >/dev/null 2>&1; then
  echo "Hermes CLI not on PATH: cloud lane checks will be skipped."
  HERMES_AVAILABLE=0
fi

echo "[3/6] Health check"
python3 scripts/hermes_orchestrator.py --config config/orchestration.json health

echo "[4/6] Route check (cloud blocked)"
python3 scripts/hermes_orchestrator.py --config config/orchestration.json route --reason-code SMOKE_CHECK

echo "[5/6] Delegated self-hosted check"
if grep -q "REPLACE_WITH" config/orchestration.json; then
  echo "Skipping delegated smoke checks: a lane endpoint is still a placeholder."
  exit 0
fi

CODING_OUTPUT="$(mktemp)"
python3 scripts/hermes_orchestrator.py \
  --config config/orchestration.json \
  subagents \
  --task "Return exactly: smoke-selfhosted-ok" \
  --preset coding > "$CODING_OUTPUT"
assert_lane "$CODING_OUTPUT" "github-premium-cloud" "not-equals"

echo "[6/6] Premium fallback check"
if [[ "$HERMES_AVAILABLE" -ne 1 ]]; then
  echo "Skipping premium fallback check: hermes CLI unavailable on this host."
  exit 0
fi

REASONING_OUTPUT="$(mktemp)"
if ! python3 scripts/hermes_orchestrator.py \
  --config config/orchestration.json \
  subagents \
  --task "Return exactly: smoke-premium-ok" \
  --preset reasoning > "$REASONING_OUTPUT"; then
  echo "Premium fallback execution failed. Verify local Hermes configuration and model access."
  exit 1
fi
assert_lane "$REASONING_OUTPUT" "github-premium-cloud" "equals"
