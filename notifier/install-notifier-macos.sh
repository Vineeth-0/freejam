#!/bin/bash
# FreeJam background notifier installer for macOS.
#
# Usage:
#   bash install-notifier-macos.sh
#   bash install-notifier-macos.sh FJN1...
#
# Requires Node.js 18 or newer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE="${1:-}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org/ and run this installer again." >&2
  exit 1
fi

if [ -z "$CODE" ]; then
  read -r -p "Paste the FJN1 notifier setup code: " CODE
fi

case "$CODE" in
  FJN1.*) ;;
  *)
    echo "That does not look like a FreeJam notifier setup code (it should start with FJN1.)." >&2
    exit 1
    ;;
esac

APP_DIR="$HOME/Library/Application Support/FreeJam"
INSTALL_DIR="$APP_DIR/notifier"
CONFIG="$APP_DIR/notifier.json"
PLIST="$HOME/Library/LaunchAgents/com.freejam.notifier.plist"
NODE_BIN="$(command -v node)"

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents"
cp "$SCRIPT_DIR/freejam-notifier.js" "$INSTALL_DIR/freejam-notifier.js"

echo "FreeJam: saving notifier setup..."
node "$INSTALL_DIR/freejam-notifier.js" --install "$CODE" --config "$CONFIG"

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g'
}

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.freejam.notifier</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$INSTALL_DIR/freejam-notifier.js")</string>
    <string>--config</string>
    <string>$(xml_escape "$CONFIG")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$INSTALL_DIR/notifier.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$INSTALL_DIR/notifier.log")</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "FreeJam background notifier installed."
echo "It starts automatically at login and is running now."
echo "Config: $CONFIG"
echo "Test it: node \"$INSTALL_DIR/freejam-notifier.js\" --test --config \"$CONFIG\""
echo "Uninstall: bash \"$SCRIPT_DIR/uninstall-notifier-macos.sh\""
echo ""
echo "If no notification appears, allow notifications for Terminal (or the app"
echo "you use to run this script) in System Settings -> Notifications."
