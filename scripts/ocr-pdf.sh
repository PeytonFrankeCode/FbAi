#!/usr/bin/env bash
# Render a PDF's pages and OCR them.
#
# These 2017 source PDFs were compressed in a way that stripped every text
# encoding (no cmap, no /ToUnicode, blanked post table), so the text can't be
# read out of the file — but the glyphs still DRAW correctly, so rendering the
# page and reading it back recovers the text.
#
# Batched because 3,251 pages of PNG is ~1.6GB; each batch is deleted once
# OCR'd. Parallel across cores since both steps are CPU-bound.
set -u
PDF="$1"; OUT="$2"; DPI="${3:-200}"; BATCH="${4:-100}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PAGES=$(pdfinfo "$PDF" 2>/dev/null | awk '/^Pages/{print $2}')
JOBS=$(nproc)
# One OpenMP thread per tesseract. Left at the default, each of the JOBS
# processes spawns its own thread pool and they fight over the same cores:
# a page that takes 1.4s alone took 14.2s under contention. Output is
# byte-identical either way. Exported AFTER nproc on purpose — nproc
# reports min(cores, OMP_THREAD_LIMIT), so exporting first pins JOBS to 1.
export OMP_THREAD_LIMIT=1
: > "$OUT"
echo "pages=$PAGES dpi=$DPI batch=$BATCH jobs=$JOBS -> $OUT"
for ((s=1; s<=PAGES; s+=BATCH)); do
  e=$((s+BATCH-1)); (( e>PAGES )) && e=$PAGES
  pdftoppm -r "$DPI" -f "$s" -l "$e" -png "$PDF" "$TMP/p" 2>/dev/null
  ls "$TMP"/p-*.png 2>/dev/null | xargs -P "$JOBS" -I{} sh -c 'tesseract "$1" "${1%.png}" --psm 6 2>/dev/null' _ {}
  # Page order matters: sort numerically so cards stay in sequence.
  for f in $(ls "$TMP"/p-*.txt 2>/dev/null | sort -V); do cat "$f" >> "$OUT"; printf '\n' >> "$OUT"; done
  rm -f "$TMP"/p-*.png "$TMP"/p-*.txt
  echo "  ...$e/$PAGES  ($(wc -c < "$OUT") bytes)"
done
echo "done: $OUT"
