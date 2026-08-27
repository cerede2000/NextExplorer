/**
 * Give tests a Web Storage that behaves like a browser's.
 *
 * Node 25 exposes its own `localStorage` global, and it wins over the one jsdom
 * installs — but it is backed by a file Node was never given, so it arrives
 * without the methods the standard defines. Any test that clears storage
 * between cases fails on `localStorage.clear is not a function`, and the
 * failure points at the test rather than at the environment.
 *
 * Replaced only when it is actually broken, so a future Node that provides a
 * working one is left alone.
 */

const createStorage = () => {
  const entries = new Map();

  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => (entries.has(String(key)) ? entries.get(String(key)) : null),
    setItem: (key, value) => {
      entries.set(String(key), String(value));
    },
    removeItem: (key) => {
      entries.delete(String(key));
    },
    clear: () => {
      entries.clear();
    },
  };
};

const isUsable = (storage) =>
  Boolean(storage) &&
  typeof storage.clear === 'function' &&
  typeof storage.getItem === 'function' &&
  typeof storage.setItem === 'function';

for (const name of ['localStorage', 'sessionStorage']) {
  if (isUsable(globalThis[name])) continue;

  const storage = createStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, {
      value: storage,
      writable: true,
      configurable: true,
    });
  }
}
