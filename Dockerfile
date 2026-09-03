# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Base: Alpine with Node.js
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:24.16-alpine3.23 AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 1: Backend production dependencies
#
# Native modules (node-pty, better-sqlite3) need compilation on Alpine musl.
# Build tools are installed here and NOT carried into the final image.
# ---------------------------------------------------------------------------
FROM base AS backend_deps
ENV NODE_ENV=production
WORKDIR /app

# Build toolchain for native modules — only lives in this stage.
RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY docs/package.json docs/package.json
RUN npm ci --omit=dev --workspace backend && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: Frontend build (dev dependencies, discarded after build)
# ---------------------------------------------------------------------------
FROM base AS frontend_build
ENV NODE_ENV=development
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY docs/package.json docs/package.json
RUN npm ci --workspace frontend
COPY frontend/ ./frontend/
RUN npm run -w frontend build -- --sourcemap false

# ---------------------------------------------------------------------------
# Stage 3: Official static 7-Zip
#
# Alpine's p7zip build does not include the RAR codec.  Use the official,
# architecture-specific static binary instead so zip, 7z and RAR extraction
# have the same capabilities in the full and lean images.
# ---------------------------------------------------------------------------
FROM alpine:3.23 AS seven_zip
ARG TARGETARCH
ARG SEVEN_ZIP_VERSION=26.01

RUN apk add --no-cache curl libarchive-tools \
  && case "$TARGETARCH" in \
    amd64) archive_arch=x64; archive_sha256=8ea0fc8a135e7b848e80a4116fe22dff56c8c4518dde1f43cce67f4e340b437a ;; \
    arm64) archive_arch=arm64; archive_sha256=39f8c9070c300a63c7484d9a983119ef3edf841e1ddf69f1affae29fdec5f612 ;; \
    *) echo "Unsupported 7-Zip architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive_version=$(printf '%s' "$SEVEN_ZIP_VERSION" | tr -d .) \
  && curl -fsSL -o /tmp/7z.tar.xz "https://github.com/ip7z/7zip/releases/download/${SEVEN_ZIP_VERSION}/7z${archive_version}-linux-${archive_arch}.tar.xz" \
  && echo "${archive_sha256}  /tmp/7z.tar.xz" | sha256sum -c - \
  && mkdir -p /out /tmp/7z \
  && bsdtar -xJf /tmp/7z.tar.xz -C /tmp/7z \
  && install -m 0755 "$(find /tmp/7z -type f -name 7zzs -print -quit)" /out/7z

# ---------------------------------------------------------------------------
# ffmpeg, built here rather than taken from anywhere.
#
# Alpine's `ffmpeg` package is a full build: 106 MB of codec libraries behind a
# 0.6 MB binary, and almost all of that weight is *encoding* — x264, x265, aom,
# vpx, lame, opus, theora, ass. This application only ever decodes: one frame
# for a video thumbnail, one still out of a HEIC, and ffprobe for metadata.
#
# So the shape of this build is deliberately the opposite of the obvious one.
# `--disable-everything` would be smaller still and is the wrong tool: it is
# opt-in, and the way it fails is a format quietly losing its previews with
# nothing logged anywhere. Instead every native decoder, demuxer and parser is
# kept — they are small — and only the encoders and muxers are cut back to the
# two we write. Nothing this application can open stops being openable.
#
# `--disable-autodetect` means the build cannot pick up a library by accident,
# so what is linked is exactly what is listed. libdav1d is the one external
# decoder worth having: ffmpeg's native AV1 decoder works but is much slower.
# No `--enable-gpl`, because nothing here needs a GPL component once the
# encoders are gone — the result is LGPL.
#
# The checksum is pinned the way the 7-Zip download above is. ffmpeg.org also
# publishes a detached signature (ffmpeg-<version>.tar.xz.asc) for anyone who
# wants to go further than pinning the bytes.
# ---------------------------------------------------------------------------
FROM alpine:3.23 AS ffmpeg_build
ARG FFMPEG_VERSION=8.1.2
ARG FFMPEG_SHA256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c

# `ffmpeg` here is a build dependency and never ships: the verification below
# uses it to synthesise a clip per format, which the binary we build then has
# to decode.
# No `-static` variants: this links against Alpine's shared libraries, which
# keeps the binary small and leaves security updates to apk rather than to a
# rebuild. `dav1d-static` does not exist in Alpine 3.23 in any case.
RUN apk add --no-cache \
      build-base coreutils curl xz pkgconf nasm yasm \
      zlib-dev bzip2-dev dav1d-dev \
      ffmpeg

RUN curl -fsSL -o /tmp/ffmpeg.tar.xz \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
  && mkdir -p /tmp/ffmpeg-src \
  && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-src --strip-components=1

WORKDIR /tmp/ffmpeg-src
RUN ./configure \
      --prefix=/out \
      --disable-autodetect \
      --disable-doc \
      --disable-debug \
      --disable-network \
      --disable-ffplay \
      --enable-zlib \
      --enable-bzlib \
      --enable-libdav1d \
      --disable-encoders \
      --enable-encoder=mjpeg \
      --enable-encoder=png \
      --enable-encoder=webvtt \
      --disable-muxers \
      --enable-muxer=image2 \
      --enable-muxer=image2pipe \
      --enable-muxer=rawvideo \
      --enable-muxer=webvtt \
      --enable-small \
  && make -j"$(nproc)" \
  && make install

# Fails the build if any format the explorer offers previews for cannot be
# decoded. See docker/verify-ffmpeg.sh for what that means and why.
COPY docker/verify-ffmpeg.sh /usr/local/bin/verify-ffmpeg.sh
RUN chmod +x /usr/local/bin/verify-ffmpeg.sh \
  && /usr/local/bin/verify-ffmpeg.sh /out/bin/ffmpeg /out/bin/ffprobe \
  && strip /out/bin/ffmpeg /out/bin/ffprobe \
  && ls -la /out/bin

FROM base AS runtime
ENV NODE_ENV=production
# Enlarge the libuv thread pool so directory-listing fs.stat calls are not
# starved by concurrent thumbnail-generation fs operations (keeps navigation
# responsive while a large media folder is being processed). Tunable at runtime.
ENV UV_THREADPOOL_SIZE=16

# Create the baseline app user; UID/GID may be mutated at runtime via entrypoint.sh.
# Alpine uses busybox addgroup/adduser instead of Debian's groupadd/useradd.
RUN addgroup -S appuser && \
    adduser -S -G appuser -s /bin/bash appuser

# Runtime packages only.
#
# Core (always installed):
#   ffmpeg          – video thumbnails and metadata, and HEIC stills: since 7.1
#                     its HEIF demuxer reconstructs the tile grid a phone photo
#                     is made of, which is why ImageMagick is no longer here.
#   gosu            – UID/GID remapping in entrypoint
#   ripgrep         – fast file-content search
#   poppler-utils   – pdftotext, so a search can read the words in a PDF. Only
#                     ones with a text layer; a scan needs OCR, which is
#                     seconds per page and does not belong in a request.
#   openssh-client  – optional SSH remote access (terminal only)
#   7zzs            – official static 7-Zip binary, copied below; supports
#                     encrypted ZIP/7z/RAR archives and the RAR codec
#   bash            – entrypoint.sh is a bash script
#   shadow          – provides usermod/groupmod for UID/GID remapping
#   curl            – For terminal users
#   rsync           – native, cancellable local copies with byte progress
#
# Optional (see INCLUDE_RAW / INCLUDE_VAAPI build args below):
#   perl            – required by exiftool-vendored for RAW image previews
#   libva           – core VA-API runtime (includes libva-drm)
#   mesa-va-gallium – Mesa VA-API GPU drivers (pulls Mesa + LLVM: 211 MB, measured
#                     as the marginal cost of libva + mesa-va-gallium over the
#                     rest of this list, against the Alpine 3.23 package index)


# Optional feature stacks — toggled at build time. Defaults keep the FULL image
# byte-for-byte identical to before.
#   INCLUDE_RAW=false    drops perl + the exiftool-vendored node module: removes
#                        RAW-photo previews only (normal EXIF still works via exifr).
#   INCLUDE_VAAPI=false  drops libva + mesa-va-gallium (Mesa + LLVM, 211 MB): ffmpeg
#                        still decodes video in software. VA-API is opt-in anyway,
#                        used only when FFMPEG_HWACCEL is set with a GPU passed in.
#                        This is by far the largest thing in the image, and it is
#                        inert on any host that does not pass a GPU to the
#                        container: the -lean variant exists mainly to drop it.
#   FFMPEG_VARIANT=source  builds ffmpeg from source with the encoders stripped
#                        out (see the ffmpeg_build stage). Every decoder,
#                        demuxer and parser is kept, so nothing stops being
#                        previewable. Requires INCLUDE_VAAPI=false: that build
#                        has no VA-API, and enabling it would pull back most of
#                        what this removes.
ARG INCLUDE_RAW=true
ARG INCLUDE_VAAPI=true
ARG FFMPEG_VARIANT=apk

RUN apk add --no-cache \
      gosu \
      ripgrep \
      poppler-utils \
      openssh-client \
      bash \
      shadow \
      curl \
      rsync \
  && if [ "$INCLUDE_RAW" = "true" ]; then apk add --no-cache perl; fi \
  && if [ "$INCLUDE_VAAPI" = "true" ]; then apk add --no-cache libva mesa-va-gallium; fi \
  && rm -rf /tmp/* /var/cache/apk/*

# ffmpeg, from one source or the other. The build stage is mounted rather than
# copied, so an `apk` build carries none of its bytes into any layer.
#
# The runtime libraries have to come with it: this build links against the
# Alpine ones rather than being static, which keeps it small and keeps the
# security updates coming from apk rather than from a rebuild.
RUN --mount=from=ffmpeg_build,source=/out,target=/ffmpeg-built \
    set -eu; \
    if [ "$FFMPEG_VARIANT" = "source" ]; then \
      if [ "$INCLUDE_VAAPI" = "true" ]; then \
        echo "FFMPEG_VARIANT=source has no VA-API; build with INCLUDE_VAAPI=false" >&2; \
        exit 1; \
      fi; \
      apk add --no-cache dav1d libbz2; \
      install -m 0755 /ffmpeg-built/bin/ffmpeg /ffmpeg-built/bin/ffprobe /usr/local/bin/; \
    else \
      apk add --no-cache ffmpeg; \
    fi; \
    rm -rf /var/cache/apk/*; \
    ffmpeg -version >/dev/null; \
    ffprobe -version >/dev/null

WORKDIR /app

# Make git metadata available at runtime for backend /api/features endpoint.
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ARG REPO_URL=""
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_BRANCH=${GIT_BRANCH}
ENV REPO_URL=${REPO_URL}

# Bring in backend production node_modules (pre-compiled for Alpine musl).
# Build tools from backend_deps stage are NOT included — only the output.
#
# Mounted and copied in one step rather than COPY'd, so that a build without RAW
# support can drop the vendored ExifTool before the layer is committed. Deleting
# it afterwards, which is what this did, removes it from the filesystem and from
# nothing else: the bytes stay in the earlier layer, get pulled on every pull,
# and are still counted in the image size. That was 23 MB of Perl in the lean
# image, with no interpreter present to run it.
#
# The same step drops any `coverage/` a dependency published by accident — 11 MB
# of it, almost entirely fluent-ffmpeg, whose npm tarball carries its own V8
# coverage dumps beside a lib/ of 110 KB. Nothing requires its own coverage
# output at runtime, so the rule is safe to apply across the tree.
RUN --mount=from=backend_deps,source=/app,target=/deps \
    set -eu; \
    cp -a /deps/node_modules ./node_modules; \
    cp /deps/package.json ./; \
    if [ "$INCLUDE_RAW" != "true" ]; then \
      rm -rf node_modules/exiftool-vendored node_modules/exiftool-vendored.pl; \
    fi; \
    find node_modules -type d \( -name coverage -o -name .nyc_output \) \
      -prune -exec rm -rf {} +
COPY --from=seven_zip /out/7z /usr/local/bin/7z
COPY docker/verify-7zip-password.js ./verify-7zip-password.js
# Verify both the RAR codec and the non-interactive password flow through the
# same PTY mechanism used by the backend. The sentinel password is build-only.
RUN 7z i | grep -qi 'rar' \
  && mkdir -p /tmp/7z-password-check/input /tmp/7z-password-check/output \
  && printf 'ok' > /tmp/7z-password-check/input/check.txt \
  && (cd /tmp/7z-password-check/input && 7z a -t7z -y -pbuild-check ../archive.7z check.txt >/dev/null) \
  && node ./verify-7zip-password.js /tmp/7z-password-check/archive.7z /tmp/7z-password-check/output build-check \
  && test "$(cat /tmp/7z-password-check/output/check.txt)" = 'ok' \
  && rm -rf /tmp/7z-password-check ./verify-7zip-password.js

# Copy backend source and healthcheck.
COPY backend/src ./src
COPY docker/healthcheck.js ./healthcheck.js

# Copy built frontend assets.
RUN mkdir -p src/public
COPY --from=frontend_build /app/frontend/dist/ ./src/public/

# Ensure the runtime user can read/traverse the app source tree
# (host checkouts may have restrictive umasks like 077).
RUN chmod -R a+rX /app/src

# Bootstrap entrypoint script responsible for dynamic user mapping.
COPY docker/entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/config", "/cache"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD [ "node", "healthcheck.js" ]

EXPOSE 3000
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "src/server.js"]
