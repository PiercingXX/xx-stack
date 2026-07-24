is_obsolete_unmanaged_skill_shim() {
  local target_dir="$1"
  local source_skill_dir="$2"
  local skill_file="$target_dir/SKILL.md"
  local source_skill_file="$source_skill_dir/SKILL.md"
  local nullglob_was_set=0
  local dotglob_was_set=0

  [ -d "$target_dir" ] || return 1
  [ ! -f "$target_dir/.xx-stack-exported" ] || return 1
  [ -f "$skill_file" ] || return 1
  [ -f "$source_skill_file" ] || return 1

  if shopt -q nullglob; then
    nullglob_was_set=1
  else
    shopt -s nullglob
  fi

  if shopt -q dotglob; then
    dotglob_was_set=1
  else
    shopt -s dotglob
  fi

  local entry
  for entry in "$target_dir"/*; do
    [ -e "$entry" ] || continue
    if [ "$(basename "$entry")" != "SKILL.md" ]; then
      [ "$nullglob_was_set" -eq 1 ] || shopt -u nullglob
      [ "$dotglob_was_set" -eq 1 ] || shopt -u dotglob
      return 1
    fi
  done

  [ "$nullglob_was_set" -eq 1 ] || shopt -u nullglob
  [ "$dotglob_was_set" -eq 1 ] || shopt -u dotglob

  if [ -L "$skill_file" ]; then
    local resolved_target
    local resolved_source
    resolved_target="$(readlink -f "$skill_file" 2>/dev/null || true)"
    resolved_source="$(readlink -f "$source_skill_file" 2>/dev/null || true)"
    if [ -n "$resolved_target" ] && [ "$resolved_target" = "$resolved_source" ]; then
      return 0
    fi
  fi

  cmp -s "$skill_file" "$source_skill_file"
}

collect_obsolete_unmanaged_skill_shims() {
  local source_skills_dir="$1"
  local opencode_skills_dir="$2"

  OBSOLETE_UNMANAGED_SKILL_SHIMS=()

  for skill_dir in "$source_skills_dir"/*; do
    [ -d "$skill_dir" ] || continue
    [ -f "$skill_dir/SKILL.md" ] || continue

    local skill_name
    local target_dir
    skill_name="$(basename "$skill_dir")"
    target_dir="$opencode_skills_dir/$skill_name"

    if is_obsolete_unmanaged_skill_shim "$target_dir" "$skill_dir"; then
      OBSOLETE_UNMANAGED_SKILL_SHIMS+=("$target_dir")
    fi
  done
}

prune_obsolete_unmanaged_skill_shims() {
  local source_skills_dir="$1"
  local opencode_skills_dir="$2"

  collect_obsolete_unmanaged_skill_shims "$source_skills_dir" "$opencode_skills_dir"

  if [ ${#OBSOLETE_UNMANAGED_SKILL_SHIMS[@]} -eq 0 ]; then
    return 0
  fi

  echo "  detected obsolete unmanaged skill shims: ${#OBSOLETE_UNMANAGED_SKILL_SHIMS[@]}"
  local target_dir
  for target_dir in "${OBSOLETE_UNMANAGED_SKILL_SHIMS[@]}"; do
    echo "    - $(basename "$target_dir")"
  done

  if [ "$PRUNE_UNMANAGED_SHIMS" != "1" ]; then
    echo "  rerun with --prune-unmanaged-shims to review and remove these directories"
    return 0
  fi

  if [ "$CONFIRM_PRUNE_UNMANAGED_SHIMS" != "1" ]; then
    if [ ! -t 0 ]; then
      echo "warning: refusing to prune unmanaged skill shims without explicit confirmation; rerun with --confirm-prune-unmanaged-shims for non-interactive use." >&2
      return 0
    fi

    local response
    printf "  type 'prune obsolete shims' to remove these directories: "
    IFS= read -r response
    if [ "$response" != "prune obsolete shims" ]; then
      echo "  keeping obsolete unmanaged skill shims"
      return 0
    fi
  fi

  local removed=0
  for target_dir in "${OBSOLETE_UNMANAGED_SKILL_SHIMS[@]}"; do
    rm -rf "$target_dir"
    removed=$((removed + 1))
  done
  echo "  removed obsolete unmanaged skill shims: $removed"
}

export_skills_for_opencode() {
  local source_skills_dir="$1"
  local opencode_skills_dir="$2"
  local exported=0
  local skipped=0
  local removed=0

  if [ ! -d "$source_skills_dir" ]; then
    echo "warning: source skills directory not found: $source_skills_dir" >&2
    return 1
  fi

  mkdir -p "$opencode_skills_dir"

  for target_dir in "$opencode_skills_dir"/*; do
    [ -d "$target_dir" ] || continue
    [ -f "$target_dir/.xx-stack-exported" ] || continue

    local target_name
    target_name="$(basename "$target_dir")"
    if [ ! -f "$source_skills_dir/$target_name/SKILL.md" ]; then
      rm -rf "$target_dir"
      removed=$((removed + 1))
    fi
  done

  for skill_dir in "$source_skills_dir"/*; do
    [ -d "$skill_dir" ] || continue
    [ -f "$skill_dir/SKILL.md" ] || continue

    local skill_name
    local target_dir
    skill_name="$(basename "$skill_dir")"
    target_dir="$opencode_skills_dir/$skill_name"

    if [ -d "$target_dir" ] && [ ! -f "$target_dir/.xx-stack-exported" ]; then
      skipped=$((skipped + 1))
      if is_obsolete_unmanaged_skill_shim "$target_dir" "$skill_dir"; then
        echo "warning: obsolete unmanaged skill shim '$skill_name' exists; rerun with --prune-unmanaged-shims to remove and recreate it." >&2
      else
        echo "warning: skill '$skill_name' exists and is not managed by xx-stack; skipping." >&2
      fi
      continue
    fi

    mkdir -p "$target_dir"
    rm -f "$target_dir/SKILL.md"
    ln -s "$skill_dir/SKILL.md" "$target_dir/SKILL.md"
    printf 'managed-by=xx-stack\n' > "$target_dir/.xx-stack-exported"
    exported=$((exported + 1))
  done

  echo "  exported skill shims: $exported"
  if [ "$removed" -gt 0 ]; then
    echo "  removed stale exported skills: $removed"
  fi
  if [ "$skipped" -gt 0 ]; then
    echo "  skipped skills (existing unmanaged): $skipped"
  fi
  return 0
}