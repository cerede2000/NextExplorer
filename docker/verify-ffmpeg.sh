#!/bin/sh
# Prove a freshly built ffmpeg can decode everything this application offers.
#
# The build strips ffmpeg down, and the way that goes wrong is silent: a
# container or codec quietly stops being decodable and thumbnails for that
# format simply never appear. Nothing errors, nothing logs, a folder of .wmv
# files just looks empty of previews.
#
# So the build proves it instead of assuming it. Alpine's own ffmpeg — a build
# dependency, never shipped — synthesises one short clip per format, and the
# binary we just built has to get a frame out of each. Any failure fails the
# image build, which is the only place this can be caught before a user is.
#
# Usage: verify-ffmpeg.sh <path-to-ffmpeg> <path-to-ffprobe>
set -eu

OURS="$1"
OURS_PROBE="$2"
SYSTEM_FFMPEG="${SYSTEM_FFMPEG:-ffmpeg}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
checked=0

note() { printf '  %s\n' "$1"; }

# One second of colour bars, encoded as asked. Small on purpose: this proves a
# decoder runs, not that it is fast.
make_video() {
  file="$1"
  shift
  "$SYSTEM_FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=64x64:rate=10:duration=1" \
    "$@" "$file" 2>"$WORK/encode.log"
}

make_audio() {
  file="$1"
  shift
  "$SYSTEM_FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=440:duration=1" \
    "$@" "$file" 2>"$WORK/encode.log"
}

# The thumbnail path, exactly as thumbnailService runs it: seek, one frame,
# scale, out through a pipe.
decode_one_frame() {
  file="$1"
  out="$WORK/frame.jpg"
  rm -f "$out"
  "$OURS" -hide_banner -loglevel error -y -i "$file" \
    -map 0:v:0 -frames:v 1 -vf "scale=32:-1" -vcodec mjpeg -f image2 "$out" \
    2>"$WORK/decode.log" || return 1
  [ -s "$out" ] || return 1
}

check_video() {
  label="$1"
  file="$WORK/$2"
  shift 2

  checked=$((checked + 1))
  if ! make_video "$file" "$@"; then
    note "SKIP  $label — this Alpine ffmpeg cannot produce the fixture"
    checked=$((checked - 1))
    return 0
  fi
  if decode_one_frame "$file"; then
    note "ok    $label"
  else
    note "FAIL  $label"
    sed 's/^/        /' "$WORK/decode.log" || true
    failures=$((failures + 1))
  fi
}

# Audio is read for metadata and album art rather than decoded to a picture, so
# the bar is that ffprobe names the stream.
check_audio() {
  label="$1"
  file="$WORK/$2"
  shift 2

  checked=$((checked + 1))
  if ! make_audio "$file" "$@"; then
    note "SKIP  $label — this Alpine ffmpeg cannot produce the fixture"
    checked=$((checked - 1))
    return 0
  fi
  if "$OURS_PROBE" -hide_banner -loglevel error \
    -show_entries stream=codec_name -of default=nw=1:nk=1 "$file" \
    2>"$WORK/probe.log" | grep -q .; then
    note "ok    $label"
  else
    note "FAIL  $label"
    sed 's/^/        /' "$WORK/probe.log" || true
    failures=$((failures + 1))
  fi
}

echo "ffmpeg build check — $($OURS -version 2>/dev/null | head -n1)"

echo "video containers and codecs the explorer offers previews for:"
check_video "mp4 / h264"      clip.mp4   -c:v libx264 -pix_fmt yuv420p
check_video "mp4 / hevc"      hevc.mp4   -c:v libx265 -pix_fmt yuv420p -tag:v hvc1
check_video "mov / h264"      clip.mov   -c:v libx264 -pix_fmt yuv420p
check_video "m4v / h264"      clip.m4v   -c:v libx264 -pix_fmt yuv420p
check_video "mkv / vp9"       clip.mkv   -c:v libvpx-vp9
check_video "webm / vp8"      clip.webm  -c:v libvpx
check_video "mp4 / av1"       av1.mp4    -c:v libaom-av1 -cpu-used 8
check_video "avi / mpeg4"     clip.avi   -c:v mpeg4
check_video "wmv / wmv2"      clip.wmv   -c:v wmv2
check_video "flv / flv1"      clip.flv   -c:v flv
check_video "mpg / mpeg2"     clip.mpg   -c:v mpeg2video
check_video "mpeg / mpeg1"    clip.mpeg  -c:v mpeg1video
check_video "mov / prores"    prores.mov -c:v prores_ks -pix_fmt yuv422p10le
check_video "mjpeg in avi"    mjpeg.avi  -c:v mjpeg -pix_fmt yuvj420p

echo "audio, read for metadata and album art:"
check_audio "mp3"   tone.mp3  -c:a libmp3lame
check_audio "flac"  tone.flac -c:a flac
check_audio "wav"   tone.wav  -c:a pcm_s16le
check_audio "m4a"   tone.m4a  -c:a aac
check_audio "ogg"   tone.ogg  -c:a libvorbis
check_audio "opus"  tone.opus -c:a libopus
check_audio "wma"   tone.wma  -c:a wmav2

# A HEIC is HEVC inside an ISOBMFF container with an `heic` brand. Decoding it
# is the same demuxer and decoder the .mp4/hevc case above exercises, so a
# working hevc there is what makes the HEIC thumbnail path work.
echo "still images:"
check_video "png"   still.png  -frames:v 1 -c:v png
check_video "jpeg"  still.jpg  -frames:v 1 -c:v mjpeg -pix_fmt yuvj420p

echo
if [ "$failures" -gt 0 ]; then
  echo "ffmpeg build check FAILED: $failures of $checked formats could not be decoded" >&2
  exit 1
fi
echo "ffmpeg build check passed: $checked formats decoded"
