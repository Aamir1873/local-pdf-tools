#!/bin/sh
# Builds Local PDF Tools, prints the guide, takes screenshots and zips the release: sh src/package.sh (needs Google Chrome)
set -e
KIT="$(cd "$(dirname "$0")/.." && pwd)"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
FILES="$KIT/release/files"
PREVIEWS="$KIT/release/previews"

node "$KIT/src/build.mjs"

# Printable guide → PDF
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="$FILES/Guide - Keep your PDFs off random websites.pdf" "file://$KIT/release/guide-print.html" 2>/dev/null
rm "$KIT/release/guide-print.html"

# Screenshots for the README (light mode). lib/shot.mjs waits until the page previews are drawn.
mkdir -p "$PREVIEWS"
APP="file://$FILES/Local%20PDF%20Tools.html"
node "$KIT/lib/shot.mjs" "$APP" "$PREVIEWS/tool.png" 1180 980
node "$KIT/lib/shot.mjs" "$APP#sample" "$PREVIEWS/pages.png" 1180 1250 --wait "document.querySelectorAll('#pages-thumbs canvas').length >= 7"
node "$KIT/lib/shot.mjs" "$APP#why" "$PREVIEWS/guide.png" 1180 1300

cd "$KIT/release"
rm -rf "Local PDF Tools" Local-PDF-Tools-v1.1.zip
cp -R files "Local PDF Tools"
zip -rqX Local-PDF-Tools-v1.1.zip "Local PDF Tools"
rm -rf "Local PDF Tools"
echo "Release: $KIT/release/Local-PDF-Tools-v1.1.zip ($(du -h Local-PDF-Tools-v1.1.zip | cut -f1))"
