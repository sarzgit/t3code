#!/usr/bin/env bash
# Installs a built helper as ~/Applications/T3 Music Up Next.app, the one copy T3 launches.
# Replacing it changes its identity, so macOS asks for Accessibility again.
set -euo pipefail
src="${1:?usage: install.sh <built T3 Music Up Next.app> [--replace]}"
target="$HOME/Applications/T3 Music Up Next.app"
codesign --verify --strict "$src"
mkdir -p "$HOME/Applications"
if [ -e "$target" ]; then
  [ "${2:-}" = "--replace" ] || { echo "$target exists; pass --replace to change it" >&2; exit 1; }
fi
staging="$(mktemp -d "$HOME/Applications/.t3-music-up-next.XXXXXX")"
ditto "$src" "$staging/T3 Music Up Next.app"
codesign --verify --strict "$staging/T3 Music Up Next.app"
if [ -e "$target" ]; then mv "$target" "$staging/previous.app"; fi
mv -n "$staging/T3 Music Up Next.app" "$target"
echo "installed $target (previous copy, if any, kept in $staging)"
