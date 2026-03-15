#!/usr/bin/env bash
# Resolve through symlinks so this works via `bun link` global install
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

show_help() {
  cat <<'HELP'
Usage: promptlens [command] [options]

Commands:
  (none)      Launch the interactive TUI dashboard
  import      Import and analyze prompts from Claude Code history
  help        Show this help message

Run 'promptlens <command> --help' for command-specific help.
HELP
}

case "${1:-}" in
  import)  shift; exec bun --env-file="$SCRIPT_DIR/.env" run "$SCRIPT_DIR/import.ts" "$@" ;;
  help|--help|-h) show_help ;;
  *)       exec bun run "$SCRIPT_DIR/tui.tsx" "$@" ;;
esac
