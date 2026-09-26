const MIB_BYTES = 1024 * 1024;

/** Default chunk size when the administrator has not set one. */
export const DEFAULT_CHUNK_BYTES = 8 * MIB_BYTES;

/**
 * How the next upload goes out.
 *
 * A direct upload is one request and much faster, and it is what an upload has
 * always been here. It is also what a reverse proxy refuses outright once the
 * body passes whatever limit it enforces, and what a dropped connection loses
 * entirely however far it had got. Chunked uploads answer both.
 *
 * Which one is used is the administrator's decision, and the default is
 * unchanged — so nothing about an upload moves until somebody asks.
 *
 * Kept here rather than inside the uploader because this is the part worth
 * testing, and reaching it through the composable means building Uppy, several
 * stores and a file dialog first.
 *
 * @param {object} uploads the `uploads` section of the application settings
 */
export const resolveUploadMode = (uploads = {}) => {
  const chunkSizeBytes = Number.isFinite(uploads?.chunkSizeBytes)
    ? uploads.chunkSizeBytes
    : DEFAULT_CHUNK_BYTES;

  return {
    mode: uploads?.chunkedEnabled ? 'chunked' : 'direct',
    chunkedEnabled: Boolean(uploads?.chunkedEnabled),
    chunkSizeBytes,
  };
};
