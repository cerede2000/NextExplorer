const { createRequire } = require('node:module');

/**
 * Stand `exports` in for what `fromFile` receives when it requires `request`,
 * until the returned function is called.
 *
 * For the rare collaborator a test cannot otherwise bring into the state it
 * needs — a write that has begun and not yet finished. The request is resolved
 * from `fromFile`, exactly as the code under test resolves it, so the stand-in
 * is the module that code actually gets. Require the code under test after
 * this, and restore once whatever it started has been stopped.
 */
const substituteModule = (fromFile, request, exports) => {
  const localRequire = createRequire(fromFile);
  const resolved = localRequire.resolve(request);
  const previous = localRequire.cache[resolved];

  localRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };

  return () => {
    if (previous) {
      localRequire.cache[resolved] = previous;
    } else {
      delete localRequire.cache[resolved];
    }
  };
};

module.exports = { substituteModule };
