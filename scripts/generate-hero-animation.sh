#!/usr/bin/env bash
set -euo pipefail

# Creates a small, repository-hosted GIF from the deterministic SVG topology.
# macOS `sips` rasterizes each SVG frame; ffmpeg optimizes the final loop.
root="$(cd "$(dirname "$0")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

node "$root/scripts/generate-hero.mjs" --frames "$temporary/svg"

for frame in "$temporary"/svg/*.svg; do
  name="$(basename "${frame%.svg}")"
  sips -s format png "$frame" --out "$temporary/$name.png" >/dev/null
done

ffmpeg -hide_banner -loglevel error -y -framerate 6 -i "$temporary/frame-%02d.png" \
  -vf "fps=6,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:reserve_transparent=0[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$root/assets/hero-dark.gif"
