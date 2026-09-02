/* eslint-env node */
const http = require('http');

/**
 * What Docker runs to decide whether this container is healthy.
 *
 * Two things it has to do that the first version did not. `timeout` on
 * `http.request` arms the socket but aborts nothing on its own — without a
 * listener the script simply waits, and a server that accepts the connection
 * and never answers turns into Docker's own ten-second timeout with no output
 * at all. And a non-200 deserves to say what it was: `/healthz` sits behind the
 * authentication middleware, so a redirect to an identity provider is a
 * plausible failure and looks nothing like a crash.
 */
const TIMEOUT_MS = 2000;

const request = http.request(
  {
    host: '127.0.0.1',
    port: process.env.PORT || 3000,
    path: '/healthz',
    timeout: TIMEOUT_MS,
  },
  (response) => {
    if (response.statusCode === 200) {
      response.resume();
      process.exit(0);
    }

    const location = response.headers.location ? ` -> ${response.headers.location}` : '';
    console.log(`UNHEALTHY: /healthz answered ${response.statusCode}${location}`);
    response.resume();
    process.exit(1);
  }
);

request.on('timeout', () => {
  console.log(`UNHEALTHY: /healthz did not answer within ${TIMEOUT_MS} ms`);
  request.destroy();
  process.exit(1);
});

request.on('error', (error) => {
  console.log(`UNHEALTHY: ${error.message}`);
  process.exit(1);
});

request.end();
