#!/usr/bin/env bash
# The reader against fixture trees; no Accessibility or Music needed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
xcrun swiftc -swift-version 5 "$here/Reader.swift" "$here/AXElements.swift" \
  "$here/tests/ElementsTest.swift" "$here/tests/main.swift" -framework ApplicationServices \
  -o "$out/reader-tests"
"$out/reader-tests"
