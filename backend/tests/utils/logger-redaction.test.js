import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What reaches the log, read from the log itself.
 *
 * pino writes straight to the process's standard output, so the only honest
 * place to look is there: a child process loads the real logger — and, for
 * requests, the real HTTP logging — and what it prints is what an operator's
 * log file would hold.
 */

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const runAndRead = (script) =>
  execFileSync(process.execPath, ['-e', script], {
    cwd: backendDir,
    env: { ...process.env, LOG_LEVEL: 'info', DEBUG: 'false', ENABLE_HTTP_LOGGING: 'true' },
    encoding: 'utf8',
    timeout: 20000,
  });

describe('the log', () => {
  it('never holds a cookie, an authorization header or a password, wherever they are attached', () => {
    const output = runAndRead(`
      const logger = require('./src/utils/logger');
      logger.info({ headers: { cookie: 'connect.sid=SESSION-VALUE', authorization: 'Bearer TOKEN-VALUE' } }, 'one');
      logger.info({ req: { headers: { cookie: 'connect.sid=SESSION-VALUE' } } }, 'two');
      logger.info({ body: { password: 'PASSWORD-VALUE' } }, 'three');
    `);

    expect(output).toContain('one');
    expect(output).toContain('[redacted]');
    for (const secret of ['SESSION-VALUE', 'TOKEN-VALUE', 'PASSWORD-VALUE']) {
      expect(output).not.toContain(secret);
    }
  });

  it('never holds the session cookie or a token in the address of a request it logs', () => {
    const output = runAndRead(`
      const http = require('http');
      const express = require('express');
      const { configureHttpLogging } = require('./src/middleware/logging');
      const app = express();
      configureHttpLogging(app);
      app.get('/api/probe', (req, res) => res.json({ ok: true }));
      // A Unix socket rather than a TCP port: a port picked at random here can be
      // the one a test in another worker bound on every interface, and a request
      // meant for that test would then land on this server.
      const socketPath = require('path').join(require('os').tmpdir(), 'nx-log-' + process.pid + '.sock');
      try { require('fs').unlinkSync(socketPath); } catch {}
      const server = app.listen(socketPath, () => {
        const request = http.get(
          { socketPath, path: '/api/probe?token=QUERY-TOKEN&keep=visible',
            headers: { cookie: 'connect.sid=SESSION-VALUE' } },
          (res) => { res.resume(); res.on('end', () => setTimeout(() => server.close(), 50)); }
        );
        request.on('error', () => server.close());
      });
    `);

    expect(output).toContain('/api/probe');
    expect(output).toContain('keep=visible');
    expect(output).not.toContain('QUERY-TOKEN');
    expect(output).not.toContain('SESSION-VALUE');
  });
});
