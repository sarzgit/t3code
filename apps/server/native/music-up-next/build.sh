#!/usr/bin/env bash
# Builds "T3 Music Up Next.app" into the given folder, signed ad-hoc with Hardened Runtime, and
# checks what its permission boundary relies on. Install it with ./install.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:?usage: build.sh <output-folder>}"
app="$dest/T3 Music Up Next.app"
[ -e "$app" ] && { echo "$app already exists" >&2; exit 1; }
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
xcrun swiftc -O -swift-version 5 -o "$app/Contents/MacOS/T3 Music Up Next" \
  "$here/Reader.swift" "$here/AXElements.swift" "$here/main.swift" \
  -framework AppKit -framework ApplicationServices
codesign --force --options runtime --sign - "$app"
codesign --verify --strict "$app"
details="$(codesign -dv "$app" 2>&1)"
grep -q 'flags=0x10002(adhoc,runtime)' <<<"$details" || { echo "Hardened Runtime missing" >&2; exit 1; }
if codesign -d --entitlements - "$app" 2>/dev/null | grep -q 'get-task-allow\|disable-library-validation\|allow-dyld'; then
  echo "unexpected entitlement" >&2; exit 1
fi
codesign -d -r- "$app" 2>&1 | grep -q 'cdhash' || { echo "designated requirement is not the cdhash" >&2; exit 1; }
echo "$app"
