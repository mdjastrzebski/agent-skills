#!/usr/bin/env bash
# List a repository's agent docs, or check the paths they cite.
#
# Usage: agent_docs.sh list          # every agent doc, one path per line
#        agent_docs.sh check-paths   # "missing: <path>" for each cited path that doesn't exist
#
# Run from the repository root. Read-only. Agent docs are AGENTS.md / CLAUDE.md / GEMINI.md at any
# depth, editor rule files, and everything under docs/agents/ (found with `find` too, because it may
# be hidden from git).
set -u

list() {
  { git ls-files -co --exclude-standard; find docs/agents -type f 2>/dev/null || true; } \
    | grep -iE '(^|/)(AGENTS|CLAUDE|GEMINI)\.md$|(^|/)\.cursorrules$|^\.cursor/rules/|^\.github/copilot-instructions\.md$|^\.github/instructions/|^\.windsurfrules$|^docs/agents/' \
    | sort -u || true
}

check_paths() {
  list | tr '\n' '\0' | xargs -0 grep -ohE '`[^` ]+/[^` ]*`' 2>/dev/null | tr -d '`' | grep -v '[<*]' | sort -u \
    | while read -r p; do [ -e "$p" ] || echo "missing: $p"; done
}

case "${1:-}" in
  list) list ;;
  check-paths) check_paths ;;
  *) echo "usage: $0 list|check-paths" >&2; exit 2 ;;
esac
