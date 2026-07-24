#!/usr/bin/env bash
# Install the Hermes systemd user units, substituting this checkout's absolute
# path into the unit templates. Re-run this after moving the repo.
set -euo pipefail

HERMES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_SRC="$HERMES_DIR/systemd"
UNIT_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [ ! -d "$UNIT_SRC" ]; then
  echo "error: unit templates not found at $UNIT_SRC" >&2
  exit 1
fi

mkdir -p "$UNIT_DEST"

for unit in "$UNIT_SRC"/*.service "$UNIT_SRC"/*.timer; do
  [ -e "$unit" ] || continue
  name="$(basename "$unit")"
  sed "s|__HERMES_DIR__|$HERMES_DIR|g" "$unit" > "$UNIT_DEST/$name"
  echo "installed $UNIT_DEST/$name"
done

echo
echo "Units installed against: $HERMES_DIR"
echo
echo "Next steps:"
echo "  1. Create the proxy token file (kept out of the repo):"
echo "       mkdir -p ~/.config/hermes-orchestration"
echo "       printf 'HERMES_PROXY_TOKEN=%s\\n' \"\$(openssl rand -hex 24)\" \\"
echo "         > ~/.config/hermes-orchestration/proxy.env"
echo "       chmod 600 ~/.config/hermes-orchestration/proxy.env"
echo "  2. Reload and enable:"
echo "       systemctl --user daemon-reload"
echo "       systemctl --user enable --now hermes-proxy.service"
echo "       systemctl --user enable --now hermes-capability-refresh.timer"
