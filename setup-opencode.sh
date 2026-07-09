#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./setup-opencode.sh --global
  ./setup-opencode.sh /absolute/or/relative/path/to/target-project [--force]

What it does:
  1. In global mode, installs agents, skills, and core runtime files into the legacy host config paths:
     $HOME/.config/opencode/agents/
     $HOME/.config/opencode/skills/
     $HOME/.config/opencode/config.json
     $HOME/.config/opencode/platforms.json
  2. In workspace mode, symlinks the legacy host entrypoint .opencode/ -> this xx-stack/runtime/ directory
     so the host can discover agents, skills, and config from the stack directly.
  3. In workspace mode, symlinks design pack content at the target project root:
     <target>/design-systems/   -> <xx-stack>/packs/design/design-systems/
     <target>/design-skills/    -> <xx-stack>/packs/design/design-skills/
     <target>/DESIGN-CATALOG.md -> <xx-stack>/packs/design/DESIGN-CATALOG.md

Options:
  --global  Install agents and skills into the legacy host runtime at user level.
  --force   Overwrite existing symlinks and files without confirmation.

Notes:
  - Existing symlinks/files at destination are skipped unless --force is used.
  - Global install does not link the design pack; use workspace mode for that.
  - Existing user config is merged where possible instead of blindly replaced.
  - Repo-managed agent profiles are migrated to host-native execution by clearing legacy per-agent model pins when the stack no longer declares one.
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
RUNTIME_DIR="$STACK_DIR/runtime"
DESIGN_PACK_DIR="$STACK_DIR/packs/design"
USER_HOST_DIR="$HOME/.config/opencode"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "Error: runtime directory not found under: $STACK_DIR"
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

merge_host_config() {
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

const asRecord = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const mergeAgent = (userAgent, repoAgent) => {
  const user = asRecord(userAgent);
  const repo = asRecord(repoAgent);

  const merged = {
    ...user,
    ...repo,
    toolPolicy: {
      ...asRecord(user.toolPolicy),
      ...asRecord(repo.toolPolicy),
    },
    memory: {
      ...asRecord(user.memory),
      ...asRecord(repo.memory),
    },
    coordinator: {
      ...asRecord(user.coordinator),
      ...asRecord(repo.coordinator),
    },
    permission: {
      ...asRecord(user.permission),
      ...asRecord(repo.permission),
      skill: {
        ...asRecord(asRecord(user.permission).skill),
        ...asRecord(asRecord(repo.permission).skill),
      },
    },
    options: {
      ...asRecord(user.options),
      ...asRecord(repo.options),
    },
  };

  if (!("model" in repo)) {
    delete merged.model;
  }

  return merged;
};

next.agent = { ...userAgents };
for (const [agentId, repoAgent] of Object.entries(repoAgents)) {
  next.agent[agentId] = mergeAgent(userAgents[agentId], repoAgent);
}

if (typeof next.$schema !== "string" && typeof repoConfig.$schema === "string") {
  next.$schema = repoConfig.$schema;
}

fs.writeFileSync(userConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
NODE
}

if [[ $GLOBAL -eq 1 ]]; then
  mkdir -p "$USER_HOST_DIR/agents"
  mkdir -p "$USER_HOST_DIR/skills"

  echo "[xx-stack] Syncing core runtime files..."
  for runtime_file in "$RUNTIME_DIR"/*; do
    if [[ -f "$runtime_file" && "$(basename "$runtime_file")" != "config.json" ]]; then
      copy_runtime_file "$runtime_file" "$USER_HOST_DIR/$(basename "$runtime_file")"
    fi
  done

  if [[ -f "$USER_HOST_DIR/config.json" && $FORCE -ne 1 ]]; then
    cp "$USER_HOST_DIR/config.json" "$USER_HOST_DIR/config.json.bak.$STAMP"
    echo "[xx-stack] Backed up existing file to $USER_HOST_DIR/config.json.bak.$STAMP"
  fi

  echo "[xx-stack] Merging config registry into the user-level host config..."
  merge_host_config "$RUNTIME_DIR/config.json" "$USER_HOST_DIR/config.json"

  echo "[xx-stack] Installing agents to the user-level host config..."
  cp -f "$RUNTIME_DIR"/agents/*.md "$USER_HOST_DIR/agents"/

  echo "[xx-stack] Installing skills to the user-level host config..."
  # Copy each skill directory
  for skill_dir in "$RUNTIME_DIR"/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    dest="$USER_HOST_DIR/skills/$skill_name"
    rm -rf "$dest"
    cp -R -L "$skill_dir" "$dest"
  done

  echo "[xx-stack] Installation complete."
  echo "[xx-stack] Installed to: $USER_HOST_DIR"
  exit 0
fi

# ─── Workspace install ────────────────────────────────────────────────────────

TARGET_DIR="$(cd "$TARGET_PATH" && pwd -P)"
SKIP_LEGACY_HOST_LINK=0
SKIP_DESIGN_PACK_LINKS=0

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: target directory not found: $TARGET_DIR"
  exit 1
fi

if [[ "$TARGET_DIR" == "$STACK_DIR" ]]; then
  SKIP_LEGACY_HOST_LINK=1
  SKIP_DESIGN_PACK_LINKS=1
fi

LEGACY_HOST_LINK="$TARGET_DIR/.opencode"

# Legacy host symlink
if [[ $SKIP_LEGACY_HOST_LINK -eq 0 ]]; then
  if [[ -e "$LEGACY_HOST_LINK" || -L "$LEGACY_HOST_LINK" ]]; then
    if [[ $FORCE -ne 1 ]]; then
      echo "[xx-stack] $LEGACY_HOST_LINK already exists — skipping (use --force to overwrite)"
    else
      rm -rf "$LEGACY_HOST_LINK"
      ln -s "$RUNTIME_DIR" "$LEGACY_HOST_LINK"
      echo "[xx-stack] Linked: $LEGACY_HOST_LINK -> $RUNTIME_DIR"
    fi
  else
    ln -s "$RUNTIME_DIR" "$LEGACY_HOST_LINK"
    echo "[xx-stack] Linked: $LEGACY_HOST_LINK -> $RUNTIME_DIR"
  fi
else
  echo "[xx-stack] Skipped .opencode symlink for the source repo target."
fi

# Design pack symlinks
if [[ $SKIP_DESIGN_PACK_LINKS -eq 0 ]]; then
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
else
  echo "[xx-stack] Skipped design pack symlinks for the source repo target."
fi

echo "[xx-stack] Legacy host workspace ready: $TARGET_DIR"
if [[ $SKIP_LEGACY_HOST_LINK -eq 1 ]]; then
  echo "[xx-stack] Source repo target uses runtime in place; no .opencode link created."
else
  echo "[xx-stack] Agents and skills discoverable via .opencode -> $RUNTIME_DIR"
fi
if [[ $SKIP_DESIGN_PACK_LINKS -eq 0 ]]; then
  echo "[xx-stack] Design pack symlinked at project root."
fi
