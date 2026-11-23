#!/usr/bin/env bash
# FB3-ICON D-2: regenerate the committed PNG icons from the two SVGs (ruling R37.2).
# Run from the repository root: bash web/icons/gen_icons.sh
# Renderer: cairosvg in the sanctioned qrvenv. OUT_DIR overrides the output folder (default web/icons)
# so the battery can re-render into /tmp and cmp against the committed files.
set -euo pipefail
PY=/home/akelv/.hermes/cache/scratch/qrvenv/bin/python
OUT_DIR="${OUT_DIR:-web/icons}"
"$PY" -c "import cairosvg; cairosvg.svg2png(url='web/icons/icon.svg', write_to='$OUT_DIR/icon-192.png', output_width=192, output_height=192)"
"$PY" -c "import cairosvg; cairosvg.svg2png(url='web/icons/icon.svg', write_to='$OUT_DIR/icon-512.png', output_width=512, output_height=512)"
"$PY" -c "import cairosvg; cairosvg.svg2png(url='web/icons/icon-maskable.svg', write_to='$OUT_DIR/icon-maskable-512.png', output_width=512, output_height=512)"
"$PY" -c "import cairosvg; cairosvg.svg2png(url='web/icons/icon.svg', write_to='$OUT_DIR/apple-touch-icon-180.png', output_width=180, output_height=180, background_color='#070b14')"
