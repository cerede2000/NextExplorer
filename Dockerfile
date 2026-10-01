# syntax=docker/dockerfile:1

ARG FFMPEG_IMAGE=ghcr.io/nxzai/nextexplorer-ffmpeg:8.1.3
FROM ${FFMPEG_IMAGE} AS ffmpeg


# ---------------------------------------------------------------------------
# Base: Alpine with Node.js
# ---------------------------------------------------------------------------
FROM node:24.21-alpine3.24 AS base
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
#
# Taking the binary out of apk's hands means its security updates are this
# pin's job, and the archive handlers are the part of the image a visitor
# reaches most directly: every extension in DEFAULT_ARCHIVE_EXTENSIONS is a
# parser fed bytes someone uploaded. 26.02 fixed a heap overflow in the XZ
# decoder (CVE-2026-14266, remote code execution), and `xz`/`txz` are in that
# list — so this version is not a detail to leave where it was.
# ---------------------------------------------------------------------------
FROM alpine:3.24 AS seven_zip
ARG TARGETARCH
ARG SEVEN_ZIP_VERSION=26.03

RUN apk add --no-cache curl libarchive-tools \
  && case "$TARGETARCH" in \
    amd64) archive_arch=x64; archive_sha256=dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695 ;; \
    arm64) archive_arch=arm64; archive_sha256=2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996 ;; \
    *) echo "Unsupported 7-Zip architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive_version=$(printf '%s' "$SEVEN_ZIP_VERSION" | tr -d .) \
  && curl -fsSL -o /tmp/7z.tar.xz "https://github.com/ip7z/7zip/releases/download/${SEVEN_ZIP_VERSION}/7z${archive_version}-linux-${archive_arch}.tar.xz" \
  && echo "${archive_sha256}  /tmp/7z.tar.xz" | sha256sum -c - \
  && mkdir -p /out /tmp/7z \
  && bsdtar -xJf /tmp/7z.tar.xz -C /tmp/7z \
  && install -m 0755 "$(find /tmp/7z -type f -name 7zzs -print -quit)" /out/7z


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
#   ffmpeg          – minimal video thumbnail and metadata binaries copied from
#                     the separately published multi-architecture FFmpeg image
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
# Optional RAW support. Hardware acceleration is supplied only by a custom
# FFmpeg/FFprobe pair mounted by the deployment; the bundled minimal build is
# software-only and therefore does not carry Mesa or VA-API libraries.
#   INCLUDE_RAW=false drops perl + the exiftool-vendored node module, removing
#                     RAW-photo previews only.
ARG INCLUDE_RAW=true

# Buildx selects the matching amd64 or arm64 artifact from the manifest. The
# application release copies two binaries; FFmpeg compilation runs only when
# Dockerfile.ffmpeg changes or a new FFmpeg version is published.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

RUN apk add --no-cache \
      dav1d \
      libbz2 \
      gosu \
      ripgrep \
      poppler-utils \
      openssh-client \
      bash \
      shadow \
      curl \
      rsync \
  && if [ "$INCLUDE_RAW" = "true" ]; then apk add --no-cache perl; fi \
  && ffmpeg -version >/dev/null \
  && ffprobe -version >/dev/null \
  && rm -rf /tmp/* /var/cache/apk/*

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
      -prune -exec rm -rf {} +; \
    rm -rf node_modules/@types node_modules/@redis node_modules/ioredis node_modules/@babel
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
