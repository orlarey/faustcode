#!/bin/sh
# Updates the copy of the library of the stores (spec_files_store.md, « Le code
# commun ») from a checkout of faustmodular :
#   scripts/update-fauststore.sh ../faustmodular
# It builds lib/fauststore.js there (npm run build:fauststore) and copies it to
# webapp/vendor/fauststore/, with the commit of faustmodular it comes from.
set -e
src="${1:?usage: scripts/update-fauststore.sh <faustmodular checkout>}"
dest="$(dirname "$0")/../webapp/vendor/fauststore"
(cd "$src" && npm run -s build:fauststore)
mkdir -p "$dest"
cp "$src/lib/fauststore.js" "$dest/fauststore.js"
commit="$(cd "$src" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
version="$(grep -o 'FAUSTSTORE_VERSION = "[^"]*"' "$dest/fauststore.js" | cut -d'"' -f2)"
printf 'fauststore %s, built from faustmodular %s (src/store/fauststore.ts)\n' "$version" "$commit" > "$dest/VERSION"
echo "fauststore $version ($commit) → $dest"
