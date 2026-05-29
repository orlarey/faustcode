#!/usr/bin/env bash
# build-cm6.sh — produce a single ESM bundle for CodeMirror 6.
#
# Run :
#   ./webapp/vendor/codemirror/build-cm6.sh
#
# Writes :
#   webapp/vendor/codemirror/cm6.js   ← the bundle imported by dsp.js
#   webapp/vendor/codemirror/cm6.js.map (sourcemap)
#
# Uses npx esbuild + a one-shot npm install of the dependencies in a
# transient build directory ; the resulting bundle is committed to git,
# the build dir is discarded.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$HERE/src.js" "$TMP/entry.js"
cat > "$TMP/package.json" <<'JSON'
{
  "name": "cm6-bundle",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@codemirror/state":          "^6.5.2",
    "@codemirror/view":           "^6.36.4",
    "@codemirror/commands":       "^6.7.1",
    "@codemirror/language":       "^6.10.8",
    "@codemirror/autocomplete":   "^6.18.4",
    "@codemirror/theme-one-dark": "^6.1.2",
    "@lezer/highlight":           "^1.2.1"
  }
}
JSON

echo "[cm6] installing deps in $TMP ..."
(cd "$TMP" && npm install --silent --no-audit --no-fund --loglevel=error >/dev/null)

echo "[cm6] bundling ..."
(cd "$TMP" && npx --yes esbuild entry.js \
  --bundle \
  --format=esm \
  --minify \
  --sourcemap \
  --target=es2020 \
  --outfile=cm6.js \
  --log-level=warning)

cp "$TMP/cm6.js"     "$HERE/cm6.js"
cp "$TMP/cm6.js.map" "$HERE/cm6.js.map"

echo "[cm6] bundle size :"
wc -c "$HERE/cm6.js" | awk '{printf "  %d bytes (%.1f KB)\n", $1, $1/1024}'

echo "[cm6] done."
