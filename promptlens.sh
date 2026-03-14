#!/usr/bin/env bash
# Resolve through symlinks so this works via `bun link` global install
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"
cd "$SCRIPT_DIR" && exec bun run tui.tsx "$@"
