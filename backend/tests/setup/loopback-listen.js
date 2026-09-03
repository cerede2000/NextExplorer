import net from 'node:net';

/**
 * Make a test server listen on the address its client actually dials.
 *
 * Supertest opens a server with `listen(0)` and then connects to
 * `127.0.0.1:<port>`. Given no host, Node binds the wildcard address, and the
 * kernel is free to hand out a port another process already holds on 127.0.0.1
 * specifically: the two bindings do not conflict, the wildcard being the less
 * specific of the two. The connection is then resolved the other way round —
 * 127.0.0.1 wins over the wildcard — so the request is answered by that other
 * process, and the server the test just opened never sees it.
 *
 * That is not hypothetical. macOS draws `listen(0)` ports from 49152-65535, and
 * desktop applications settle inside that range: a mail client holding
 * 127.0.0.1:61814 answered 404 to whichever request drew that port. A full run
 * opens a few thousand servers, so about one run in fifteen lost one request —
 * a different test each time, failing on a status nothing in the application
 * had produced, with no trace in any log because the request never arrived.
 *
 * Naming the address closes it: the kernel will not allocate a port already
 * taken on 127.0.0.1, so the server a test opens is the one its request
 * reaches. It has to be bound synchronously, because supertest reads
 * `address().port` on the line after `listen()` — passing a host to `listen()`
 * defers the bind past that point and hands it null.
 *
 * Only the bare `listen(0)` form is redirected; a test that names an address or
 * asks for a particular port means what it says, and is left alone.
 */
const originalListen = net.Server.prototype.listen;
const IPv4 = 4;
const DEFAULT_BACKLOG = 511;

net.Server.prototype.listen = function listen(...args) {
  const bareEphemeralPort = args[0] === 0 && (args.length === 1 || typeof args[1] === 'function');
  if (!bareEphemeralPort) return originalListen.apply(this, args);

  const onListening = args[1];
  if (onListening) this.once('listening', onListening);

  try {
    this._listen2('127.0.0.1', 0, IPv4, DEFAULT_BACKLOG, undefined, 0);
    return this;
  } catch {
    // Node no longer binds this way: fall back to what it does by default. The
    // suite is then exposed to the collision again, which is the situation it
    // was in before this file existed.
    if (onListening) this.removeListener('listening', onListening);
    return originalListen.apply(this, args);
  }
};
