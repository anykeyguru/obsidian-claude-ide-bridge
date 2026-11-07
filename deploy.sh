#!/bin/sh
# Copy the plugin into a vault: ./deploy.sh /path/to/vault
set -eu
vault="${1:?usage: $0 /path/to/vault}"
dir="$vault/.obsidian/plugins/claude-ide-bridge"
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
npm run --silent build
mkdir -p "$dir"
cp main.js manifest.json styles.css "$dir/"
echo "Deployed to $dir"
