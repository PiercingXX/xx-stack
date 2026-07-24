#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./setup-opencode.sh --global
  ./setup-opencode.sh /absolute/or/relative/path/to/target-project [--force]

What it does:
  1. In global mode, installs agents, skills, and core runtime files to:
     $HOME/.config/opencode/agents/
     $HOME/.config/opencode/skills/
     $HOME/.config/opencode/config.json
     $HOME/.config/opencode/platforms.json
  2. In workspace mode, symlinks .opencode/ -> this xx-stack/opencode/ directory
     so OpenCode discovers agents, skills, and config from the stack directly.
  3. In workspace mode, symlinks design pack content at the target project root:
     <target>/design-systems/   -> <xx-stack>/packs/design/design-systems/
     <target>/design-skills/    -> <xx-stack>/packs/design/design-skills/
     <target>/DESIGN-CATALOG.md -> <xx-stack>/packs/design/DESIGN-CATALOG.md

Options:
  --global  Install agents and skills for all OpenCode sessions (user-level).
  --force   Overwrite existing symlinks and files without confirmation.

Notes:
  - Existing files at destination are backed up (*.bak.<timestamp>) and then
    replaced; --force replaces them without creating a backup first.
  - Global install does not link the design pack; use workspace mode for that.
  - Existing user config is merged where possible instead of blindly replaced.
USAGE
}

TARGET_PATH=""
FORCE=0
GLOBAL=0

for arg in "$@"; do
  case "$arg" in
    --global)
      GLOBAL=1
      ;;
    --force)
      FORCE=1
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
OPENCODE_DIR="$STACK_DIR/opencode"
DESIGN_PACK_DIR="$STACK_DIR/packs/design"
USER_OPENCODE_DIR="$HOME/.config/opencode"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$OPENCODE_DIR" ]]; then
  echo "Error: opencode directory not found under: $STACK_DIR"
  exit 1
fi

if [[ ! -d "$DESIGN_PACK_DIR" ]]; then
  echo "Error: packs/design not found under: $STACK_DIR"
  exit 1
fi

# ─── Global install ───────────────────────────────────────────────────────────

copy_runtime_file() {
  local src="$1"
  local dst="$2"

  mkdir -p "$(dirname "$dst")"

  if [[ -e "$dst" && $FORCE -ne 1 ]]; then
    cp "$dst" "$dst.bak.$STAMP"
    echo "[xx-stack] Backed up existing file to $dst.bak.$STAMP"
  fi

  cp -f "$src" "$dst"
}

merge_opencode_config() {
  local repo_config="$1"
  local user_config="$2"

  node --input-type=module - "$repo_config" "$user_config" <<'NODE'
import fs from "node:fs";

const [repoConfigPath, userConfigPath] = process.argv.slice(2);
const repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, "utf8"));

let userConfig = {};
if (fs.existsSync(userConfigPath)) {
  const raw = fs.readFileSync(userConfigPath, "utf8");
  if (raw.trim().length > 0) {
    userConfig = JSON.parse(raw);
  }
}

const next = typeof userConfig === "object" && userConfig !== null && !Array.isArray(userConfig)
  ? { ...userConfig }
  : {};

const repoAgents = typeof repoConfig.agent === "object" && repoConfig.agent !== null ? repoConfig.agent : {};
const userAgents = typeof next.agent === "object" && next.agent !== null ? next.agent : {};

next.agent = {
  ...userAgents,
  ...repoAgents,
};

next.platformRegistry = {
  ...(typeof next.platformRegistry === "object" && next.platformRegistry !== null ? next.platformRegistry : {}),
  ...(typeof repoConfig.platformRegistry === "object" && repoConfig.platformRegistry !== null ? repoConfig.platformRegistry : {}),
  path: "platforms.json",
};

if (typeof next.$schema !== "string" && typeof repoConfig.$schema === "string") {
  next.$schema = repoConfig.$schema;
}

fs.writeFileSync(userConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
NODE
}

if [[ $GLOBAL -eq 1 ]]; then
  mkdir -p "$USER_OPENCODE_DIR/agents"
  mkdir -p "$USER_OPENCODE_DIR/skills"

  echo "[xx-stack] Syncing core runtime files..."
  for runtime_file in "$OPENCODE_DIR"/*; do
    if [[ -f "$runtime_file" && "$(basename "$runtime_file")" != "config.json" ]]; then
      copy_runtime_file "$runtime_file" "$USER_OPENCODE_DIR/$(basename "$runtime_file")"
    fi
  done

  if [[ -f "$USER_OPENCODE_DIR/config.json" && $FORCE -ne 1 ]]; then
    cp "$USER_OPENCODE_DIR/config.json" "$USER_OPENCODE_DIR/config.json.bak.$STAMP"
    echo "[xx-stack] Backed up existing file to $USER_OPENCODE_DIR/config.json.bak.$STAMP"
  fi

  echo "[xx-stack] Merging config registry into user-level OpenCode config..."
  merge_opencode_config "$OPENCODE_DIR/config.json" "$USER_OPENCODE_DIR/config.json"

  echo "[xx-stack] Installing agents to user-level OpenCode config..."
  cp -f "$OPENCODE_DIR"/agents/*.md "$USER_OPENCODE_DIR/agents"/

  echo "[xx-stack] Installing skills to user-level OpenCode config..."
  # Copy each skill directory
  for skill_dir in "$OPENCODE_DIR"/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    dest="$USER_OPENCODE_DIR/skills/$skill_name"
    rm -rf "$dest"
    cp -R -L "$skill_dir" "$dest"
  done

  echo "[xx-stack] Installation complete."
  echo "[xx-stack] Installed to: $USER_OPENCODE_DIR"
  exit 0
fi

# ─── Workspace install ────────────────────────────────────────────────────────

TARGET_DIR="$(cd "$TARGET_PATH" && pwd -P)"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: target directory not found: $TARGET_DIR"
  exit 1
fi

OPENCODE_LINK="$TARGET_DIR/.opencode"

# .opencode symlink
if [[ -e "$OPENCODE_LINK" || -L "$OPENCODE_LINK" ]]; then
  if [[ $FORCE -ne 1 ]]; then
    echo "[xx-stack] $OPENCODE_LINK already exists — skipping (use --force to overwrite)"
  else
    rm -rf "$OPENCODE_LINK"
    ln -s "$OPENCODE_DIR" "$OPENCODE_LINK"
    echo "[xx-stack] Linked: $OPENCODE_LINK -> $OPENCODE_DIR"
  fi
else
  ln -s "$OPENCODE_DIR" "$OPENCODE_LINK"
  echo "[xx-stack] Linked: $OPENCODE_LINK -> $OPENCODE_DIR"
fi

# Design pack symlinks
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

echo "[xx-stack] OpenCode workspace ready: $TARGET_DIR"
echo "[xx-stack] Agents and skills discoverable via .opencode -> $OPENCODE_DIR"
echo "[xx-stack] Design pack symlinked at project root."
