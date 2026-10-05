#!/usr/bin/env bash
# Compress validation media into reviewable artifacts.
#
#   compress_media.sh image <in> <out> [max_width=1280]
#   compress_media.sh video <in> <out.mp4> [max_seconds=60] [max_width=1280]
#   compress_media.sh gif   <in> <out.gif> [max_seconds=12] [width=720]
#   compress_media.sh sheet <in-video> <out.jpg> [frames=6]
#
# Without ffmpeg, image/video fall back to a plain copy and gif/sheet are skipped,
# with a warning on stderr, so a missing tool never fails validation.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
warn() { echo "compress_media: $*" >&2; }

[[ $# -ge 3 ]] || usage
mode=$1 in=$2 out=$3
shift 3
[[ -f "$in" ]] || { warn "input not found: $in"; exit 1; }
mkdir -p "$(dirname "$out")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  case "$mode" in
    image|video) warn "ffmpeg missing; copying $in uncompressed"; cp "$in" "$out"; exit 0 ;;
    gif|sheet) warn "ffmpeg missing; skipping $mode for $in"; exit 0 ;;
    *) usage ;;
  esac
fi

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | awk '{printf "%.2f", ($1 == "" || $1 == "N/A") ? 0 : $1}'
}

case "$mode" in
  image)
    width=${1:-1280}
    ff -i "$in" -vf "scale='min($width,iw)':-2" -frames:v 1 -update 1 "$out"
    ;;
  video)
    max_s=${1:-60} width=${2:-1280}
    ff -i "$in" -t "$max_s" -an \
      -vf "fps=15,scale='min($width,iw)':-2:flags=lanczos,format=yuv420p" \
      -c:v libx264 -preset veryfast -crf 30 -movflags +faststart "$out"
    ;;
  gif)
    max_s=${1:-12} width=${2:-720}
    filters="fps=8,scale=$width:-2:flags=lanczos"
    ff -t "$max_s" -i "$in" \
      -filter_complex "[0:v]$filters,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
      -loop 0 "$out"
    ;;
  sheet)
    frames=${1:-6}
    dur=$(duration "$in")
    if awk "BEGIN{exit !($dur <= 0)}"; then
      # webm from browsers often lacks a duration header; count decoded frames instead.
      dur=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=r_frame_rate,nb_read_packets -of csv=p=0 "$in" \
        | awk -F, '{split($1, r, "/"); fps = (r[2] > 0) ? r[1] / r[2] : 25; printf "%.2f", ($2 / fps)}')
    fi
    awk "BEGIN{exit !($dur > 0.2)}" || dur=0.2
    cols=$(( frames < 3 ? frames : 3 ))
    rows=$(( (frames + cols - 1) / cols ))
    ff -i "$in" -vf "fps=$frames/$dur,scale=480:-2,tile=${cols}x${rows}:padding=4:color=white" -frames:v 1 -update 1 -q:v 4 "$out"
    ;;
  *)
    usage
    ;;
esac

size=$(du -k "$out" | cut -f1)
echo "$out ${size}KB"
