#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./setup-vscode.sh --global
  ./setup-vscode.sh /absolute/or/relative/path/to/target-project [--force] [--rebuild]

What it does:
  0. Installs/builds mcp-server only when required, or when --rebuild is used.
  1. In global mode, installs agents and prompts to:
     $HOME/.config/Code/User/prompts/
  2. In workspace mode, creates/updates the editor workspace MCP file at <target>/.vscode/mcp.json
     by merging an xx-stack server entry into the existing file.
  3. In workspace mode, syncs agents and prompts into canonical workspace paths
    only when xx-stack is not already installed globally. If a global install is
    detected, workspace prompt copies are skipped to avoid duplicate agents.
  4. In workspace mode, symlinks design pack content at the target project root:
     <target>/design-systems/   -> <xx-stack>/packs/design/design-systems/
     <target>/design-skills/    -> <xx-stack>/packs/design/design-skills/
     <target>/DESIGN-CATALOG.md -> <xx-stack>/packs/design/DESIGN-CATALOG.md

Options:
  --global  Install agents and prompts for all editor workspaces using this adapter.
  --force   Overwrite backups and replace invalid config state without keeping prior prompts.
  --rebuild Force npm install/build for the MCP server before wiring the workspace.

Notes:
  - Existing workspace files are backed up to *.bak.<timestamp> unless --force is used.
  - Global install does not configure MCP or link the design pack; use workspace mode for those.
USAGE
}

TARGET_PATH=""
FORCE=0
GLOBAL=0
REBUILD=0

for arg in "$@"; do
  case "$arg" in
    --global)
      GLOBAL=1
      ;;
    --force)
      FORCE=1
      ;;
    --rebuild)
      REBUILD=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$TARGET_PATH" ]]; then
        TARGET_PATH="$arg"
      else
        echo "Error: unexpected argument '$arg'"
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ $GLOBAL -eq 1 && -n "$TARGET_PATH" ]]; then
  echo "Error: use either --global or a target project path, not both."
  usage
  exit 1
fi

if [[ $GLOBAL -eq 0 && -z "$TARGET_PATH" ]]; then
  echo "Error: target project path is required unless --global is used."
  usage
  exit 1
fi

STACK_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MCP_JS="$STACK_DIR/mcp-server/dist/index.js"
USER_PROMPTS_DIR="$HOME/.config/Code/User/prompts"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$STACK_DIR/mcp-server" ]]; then
  echo "Error: mcp-server directory not found under: $STACK_DIR"
  exit 1
fi

ensure_mcp_server() {
  local need_install=0
  local need_build=0
  local source_changed=0

  if [[ $REBUILD -eq 1 ]]; then
    need_install=1
    need_build=1
  fi

  if [[ ! -d "$STACK_DIR/mcp-server/node_modules" ]]; then
    need_install=1
  fi

  if [[ ! -f "$MCP_JS" ]]; then
    need_build=1
  elif find "$STACK_DIR/mcp-server/src" -type f -newer "$MCP_JS" -print -quit | grep -q .; then
    source_changed=1
    need_build=1
  elif [[ "$STACK_DIR/mcp-server/package.json" -nt "$MCP_JS" || "$STACK_DIR/mcp-server/tsconfig.json" -nt "$MCP_JS" ]]; then
    source_changed=1
    need_build=1
  fi

  if [[ $need_install -eq 0 && $need_build -eq 0 ]]; then
    echo "[xx-stack] Reusing existing MCP server build."
    return
  fi

  pushd "$STACK_DIR/mcp-server" >/dev/null

  if [[ $need_install -eq 1 ]]; then
    echo "[xx-stack] Installing MCP server dependencies..."
    npm ci
  fi

  if [[ $need_build -eq 1 ]]; then
    if [[ $source_changed -eq 1 && $REBUILD -eq 0 ]]; then
      echo "[xx-stack] Source changes detected; rebuilding MCP server..."
    else
      echo "[xx-stack] Building MCP server..."
    fi
    npm run build
  fi

  popd >/dev/null
}

write_mcp_config() {
  local config_path="$1"
  local mcp_js_path="$2"

  node --input-type=module - "$config_path" "$mcp_js_path" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [configPath, mcpJsPath] = process.argv.slice(2);
let existing = {};

if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8");
  if (raw.trim().length > 0) {
    existing = JSON.parse(raw);
  }
}

const next = typeof existing === "object" && existing !== null && !Array.isArray(existing)
  ? { ...existing }
  : {};
const servers = typeof next.servers === "object" && next.servers !== null && !Array.isArray(next.servers)
  ? { ...next.servers }
  : {};

servers["xx-stack-platform-routing"] = {
  type: "stdio",
  command: "node",
  args: [mcpJsPath],
};

next.servers = servers;

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
NODE
}

ensure_mcp_server

if [[ ! -f "$MCP_JS" ]]; then
  echo "Error: $MCP_JS is missing."
  echo "Run: cd $STACK_DIR/mcp-server && npm ci && npm run build"
  exit 1
fi

if [[ $GLOBAL -eq 1 ]]; then
  mkdir -p "$USER_PROMPTS_DIR"
  echo "[xx-stack] Installing agents to the user-level editor adapter..."
  cp -f "$STACK_DIR"/adapters/agents/*.agent.md "$USER_PROMPTS_DIR"/
  echo "[xx-stack] Installing prompts (skills) to the user-level editor adapter..."
  cp -f "$STACK_DIR"/adapters/skills/*.prompt.md "$USER_PROMPTS_DIR"/
  echo "[xx-stack] Installation complete."
  echo "[xx-stack] Installed to: $USER_PROMPTS_DIR"
  echo "[xx-stack] Reload the editor window to see the new prompts."
  exit 0
fi

TARGET_DIR="$(cd "$TARGET_PATH" && pwd -P)"
WORKSPACE_CONFIG_DIR="$TARGET_DIR/.vscode"
WORKSPACE_AGENTS_DIR="$WORKSPACE_CONFIG_DIR/agents"
WORKSPACE_PROMPTS_DIR="$WORKSPACE_CONFIG_DIR/prompts"
MCP_CONFIG_PATH="$WORKSPACE_CONFIG_DIR/mcp.json"
GLOBAL_AGENT_SENTINEL="$USER_PROMPTS_DIR/execution-orchestrator.agent.md"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: target directory not found: $TARGET_DIR"
  exit 1
fi

mkdir -p "$WORKSPACE_CONFIG_DIR"

if [[ -f "$MCP_CONFIG_PATH" && $FORCE -ne 1 ]]; then
  cp "$MCP_CONFIG_PATH" "$MCP_CONFIG_PATH.bak.$STAMP"
  echo "[xx-stack] Backed up existing MCP config to $MCP_CONFIG_PATH.bak.$STAMP"
fi

if [[ -f "$MCP_CONFIG_PATH" ]]; then
  if ! node --input-type=module - "$MCP_CONFIG_PATH" <<'NODE'
import fs from "node:fs";

const [configPath] = process.argv.slice(2);
const raw = fs.readFileSync(configPath, "utf8");
if (raw.trim().length > 0) {
  JSON.parse(raw);
}
NODE
  then
    if [[ $FORCE -ne 1 ]]; then
      echo "Error: existing MCP config is not valid JSON: $MCP_CONFIG_PATH"
      echo "Use --force to replace it after reviewing the backup."
      exit 1
    fi
    echo "[xx-stack] Replacing invalid MCP config due to --force."
    rm -f "$MCP_CONFIG_PATH"
  fi
fi

write_mcp_config "$MCP_CONFIG_PATH" "$MCP_JS"

if [[ -f "$GLOBAL_AGENT_SENTINEL" ]]; then
  echo "[xx-stack] Global xx-stack prompt install detected; skipping workspace agent/prompt sync to avoid duplicates."
else
  mkdir -p "$WORKSPACE_AGENTS_DIR"
  mkdir -p "$WORKSPACE_PROMPTS_DIR"
  cp -f "$STACK_DIR"/adapters/agents/*.agent.md "$WORKSPACE_AGENTS_DIR"/
  cp -f "$STACK_DIR"/adapters/skills/*.prompt.md "$WORKSPACE_PROMPTS_DIR"/
fi

# Design pack symlinks at target root
DESIGN_PACK_DIR="$STACK_DIR/packs/design"
for entry in design-systems design-skills DESIGN-CATALOG.md; do
  src="$DESIGN_PACK_DIR/$entry"
  dst="$TARGET_DIR/$entry"

  if [[ ! -e "$src" ]]; then
    echo "[xx-stack] Warning: design pack source not found, skipping: $src"
    continue
  fi

  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ $FORCE -ne 1 ]]; then
      echo "[xx-stack] $dst already exists — skipping (use --force to overwrite)"
      continue
    fi
    rm -rf "$dst"
  fi

  ln -s "$src" "$dst"
  echo "[xx-stack] Linked: $dst -> $src"
done

echo "[xx-stack] Linked editor workspace: $TARGET_DIR"
echo "[xx-stack] Wrote: $MCP_CONFIG_PATH"
if [[ -f "$GLOBAL_AGENT_SENTINEL" ]]; then
  echo "[xx-stack] Using global agents/prompts from: $USER_PROMPTS_DIR"
else
  echo "[xx-stack] Synced: $WORKSPACE_AGENTS_DIR"
  echo "[xx-stack] Synced: $WORKSPACE_PROMPTS_DIR"
fi
echo "[xx-stack] Design pack symlinked at project root."
echo "[xx-stack] Ready. Reload the editor window in the target workspace."
