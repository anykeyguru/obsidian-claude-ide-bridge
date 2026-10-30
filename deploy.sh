#!/bin/sh
# Copy the plugin into a vault: ./deploy.sh /path/to/vault
set -eu
vault="${1:?usage: $0 /path/to/vault}"
dir="$vault/.obsidian/plugins/claude-ide-bridge"
mkdir -p "$dir"
cp "$(dirname "$0")/main.js" "$(dirname "$0")/manifest.json" "$dir/"
echo "Deployed to $dir"
