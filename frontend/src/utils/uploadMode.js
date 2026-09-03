const MIB_BYTES = 1024 * 1024;

/** Default chunk size when the administrator has not set one. */
export const DEFAULT_CHUNK_BYTES = 8 * MIB_BYTES;

/**
 * Above this, a direct upload is worth watching for a stall. Smaller files go
 * through before a reverse proxy has a chance to cut them off, so watching them
 * only costs timers.
 */
export const LARGE_FILE_BYTES = 8 * MIB_BYTES;

/**
 * How the next upload goes out, and why.
 *
 * Three inputs decide it, and their order is the whole rule:
 *
 * 1. The administrator forcing chunked uploads wins outright. Their reason is
 *    usually a proxy they already know about, and no per-browser learning
 *    should be able to talk the client out of it.
 * 2. Otherwise, if auto-fallback is allowed and this origin has learned a chunk
 *    size — meaning a direct upload here was once refused or silently stalled —
 *    use it. The size is remembered per origin because the public URL and a LAN
 *    address sit behind different proxies.
 * 3. Otherwise go direct, which is one request and much faster.
 *
 * Extracted here for the same reason the fallback ladder was: this is the part
 * worth testing, and reaching it through the composable means building Uppy,
 * seven Pinia stores and a file dialog first.
 *
 * @param {object} uploads the `uploads` section of the application settings
 * @param {number|null} rememberedMiB chunk size this origin has learned, if any
 */
export const resolveUploadMode = (uploads = {}, rememberedMiB = null) => {
  const adminChunkBytes = Number.isFinite(uploads?.chunkSizeBytes)
    ? uploads.chunkSizeBytes
    : DEFAULT_CHUNK_BYTES;

  if (uploads?.chunkedEnabled) {
    return { mode: 'forced-chunked', chunkedEnabled: true, chunkSizeBytes: adminChunkBytes };
  }

  const remembered = uploads?.chunkedAutoFallback ? rememberedMiB : null;
  if (remembered) {
    return {
      mode: 'fallback-chunked',
      chunkedEnabled: true,
      chunkSizeBytes: remembered * MIB_BYTES,
    };
  }

  return {
    mode: uploads?.chunkedAutoFallback ? 'direct' : 'direct-no-fallback',
    chunkedEnabled: false,
    chunkSizeBytes: adminChunkBytes,
  };
};

/**
 * Whether uploads are currently going out as single requests *and* auto-fallback
 * is watching them.
 *
 * This gates the stall watchdog, so it must be false wherever there is nothing
 * to learn: with chunking forced there is no direct upload to stall, and with
 * auto-fallback switched off a stall teaches nobody anything.
 */
export const isWatchingDirectUploads = (uploads = {}, rememberedMiB = null) =>
  resolveUploadMode(uploads, rememberedMiB).mode === 'direct';

/** Whether this origin has already fallen back and is uploading in chunks. */
export const isInFallbackChunked = (uploads = {}, rememberedMiB = null) =>
  resolveUploadMode(uploads, rememberedMiB).mode === 'fallback-chunked';

/** Big enough that a proxy has time to refuse it mid-flight. */
export const isLargeUpload = (file) => (Number(file?.size) || 0) > LARGE_FILE_BYTES;
