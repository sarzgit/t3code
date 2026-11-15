#!/usr/bin/env bash
# Installs a built helper as ~/Applications/T3 Music Up Next.app, the one copy T3 launches.
# Replacing it changes its identity: its Accessibility entry is reset and must be allowed again.
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
if [ -e "$target" ]; then
  mv "$target" "$staging/previous.app"
  # The old entry stays switched on but no longer matches this build; clear only this helper's
  # entry so macOS lists the new one. This grants nothing.
  tccutil reset Accessibility codes.t3.music-up-next
fi
mv -n "$staging/T3 Music Up Next.app" "$target"
echo "installed $target (previous copy, if any, kept in $staging)"
