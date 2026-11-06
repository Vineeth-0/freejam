#!/bin/bash
# FreeJam background notifier uninstaller for macOS.
#
# Usage:
#   bash uninstall-notifier-macos.sh
#   bash uninstall-notifier-macos.sh --keep-config

set -euo pipefail

KEEP_CONFIG=0
if [ "${1:-}" = "--keep-config" ]; then
  KEEP_CONFIG=1
fi

APP_DIR="$HOME/Library/Application Support/FreeJam"
INSTALL_DIR="$APP_DIR/notifier"
CONFIG="$APP_DIR/notifier.json"
PLIST="$HOME/Library/LaunchAgents/com.freejam.notifier.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $PLIST"
fi

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "Removed $INSTALL_DIR"
fi

if [ "$KEEP_CONFIG" -eq 0 ] && [ -f "$CONFIG" ]; then
  rm -f "$CONFIG"
  echo "Removed $CONFIG"
fi

echo "FreeJam background notifier uninstalled."
