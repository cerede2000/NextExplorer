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
# Stage 4: Final runtime image — no compilers, no build tools
# ---------------------------------------------------------------------------
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
#   ffmpeg          – video thumbnail extraction & software transcoding
#   gosu            – UID/GID remapping in entrypoint
#   ripgrep         – fast file-content search
#   imagemagick     – HEIC → PNG thumbnail conversion
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
#   mesa-va-gallium – Mesa VA-API GPU drivers (pulls Mesa + LLVM, ~80 MB)


# Optional feature stacks — toggled at build time. Defaults keep the FULL image
# byte-for-byte identical to before.
#   INCLUDE_RAW=false    drops perl + the exiftool-vendored node module: removes
#                        RAW-photo previews only (normal EXIF still works via exifr).
#   INCLUDE_VAAPI=false  drops libva + mesa-va-gallium (Mesa + LLVM, ~80 MB): ffmpeg
#                        still decodes video in software. VA-API is opt-in anyway,
#                        used only when FFMPEG_HWACCEL is set with a GPU passed in.
ARG INCLUDE_RAW=true
ARG INCLUDE_VAAPI=true

RUN apk add --no-cache \
      ffmpeg \
      gosu \
      ripgrep \
      imagemagick \
      openssh-client \
      bash \
      shadow \
      curl \
      rsync \
  && if [ "$INCLUDE_RAW" = "true" ]; then apk add --no-cache perl; fi \
  && if [ "$INCLUDE_VAAPI" = "true" ]; then apk add --no-cache libva mesa-va-gallium; fi \
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
COPY --from=backend_deps /app/node_modules ./node_modules
COPY --from=backend_deps /app/package.json ./
COPY --from=seven_zip /out/7z /usr/local/bin/7z
COPY docker/verify-7zip-password.js /tmp/verify-7zip-password.js
# Verify both the RAR codec and the non-interactive password flow through the
# same PTY mechanism used by the backend. The sentinel password is build-only.
RUN 7z i | grep -qi 'rar' \
  && mkdir -p /tmp/7z-password-check/input /tmp/7z-password-check/output \
  && printf 'ok' > /tmp/7z-password-check/input/check.txt \
  && (cd /tmp/7z-password-check/input && 7z a -t7z -y -pbuild-check ../archive.7z check.txt >/dev/null) \
  && node /tmp/verify-7zip-password.js /tmp/7z-password-check/archive.7z /tmp/7z-password-check/output build-check \
  && test "$(cat /tmp/7z-password-check/output/check.txt)" = 'ok' \
  && rm -rf /tmp/7z-password-check /tmp/verify-7zip-password.js

# When RAW support is disabled, drop the vendored ExifTool (~20 MB) from the
# runtime node_modules. rawPreviewService.js already degrades gracefully when the
# module is absent (the require is wrapped in try/catch).
RUN if [ "$INCLUDE_RAW" != "true" ]; then \
      rm -rf node_modules/exiftool-vendored node_modules/exiftool-vendored.pl; \
    fi

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
