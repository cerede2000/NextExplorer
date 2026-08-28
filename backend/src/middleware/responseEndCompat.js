/**
 * @tus/server hands its responses to srvx, which finishes them with
 * `res.end(callback)`. Node accepts that form — a function in first position is
 * the completion callback, not a body — but express-session replaces res.end
 * with a two-argument `(chunk, encoding)` wrapper that has no notion of it. On
 * any request where the session has to be saved or touched, that wrapper writes
 * the body out before ending, and the callback reaches res.write() as a chunk:
 *
 *   TypeError [ERR_INVALID_ARG_TYPE]: The "chunk" argument must be of type
 *   string or an instance of Buffer or Uint8Array. Received function
 *
 * Nothing catches it, so the process exits. Every chunked upload by a
 * signed-in user took the server down with it: a 502 in the browser, and on a
 * deployment whose storage is not persistent, a database recreated empty on the
 * restart — favourites, shares and preferences gone with it.
 *
 * The store implements touch and `resave` is false, so this is the ordinary
 * path for an established session rather than a rare one.
 *
 * Mounted after the session middleware, this wrapper is the one srvx reaches
 * first: it moves the callback onto the response's own completion event and
 * passes the plain `(chunk, encoding)` form down the chain, which is all
 * express-session ever expects to see.
 */
const responseEndCompat = (req, res, next) => {
  const end = res.end;

  res.end = function normalizedEnd(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }

    if (typeof callback === 'function') {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        callback();
      };

      // A response that has already finished emits nothing further, and the
      // caller would wait for ever on a reply that has gone.
      if (res.writableEnded) {
        setImmediate(settle);
      } else {
        // 'close' as well as 'finish': a client that walks away mid-upload
        // still has to release whoever is awaiting the response.
        res.once('finish', settle);
        res.once('close', settle);
      }
    }

    return end.call(this, chunk, encoding);
  };

  next();
};

module.exports = { responseEndCompat };
