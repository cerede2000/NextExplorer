import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Which address ends up in the log.
 *
 * The complaint this answers: every line said `172.18.0.1`, the Docker
 * bridge, because that is who opened the socket. Behind a proxy the person is
 * named in a header, and a header is only worth reading when the machine that
 * sent it is one this server was told to believe — otherwise anybody on the
 * network writes their own line in the log.
 */

let clientAddress;
let normalizeAddress;
let forwardedAddressWarning;
let forgetForwardingWarning;

beforeEach(async () => {
  vi.resetModules();
  ({ clientAddress, normalizeAddress, forwardedAddressWarning, forgetForwardingWarning } =
    await import('../../src/utils/clientAddress.js'));
  forgetForwardingWarning();
});

/** A server that answers with the address it would have written down. */
const serve = (trustProxy) => {
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(forwardedAddressWarning);
  app.get('/', (req, res) => res.json({ address: clientAddress(req) }));
  return app;
};

const ask = async (app, headers = {}) => (await request(app).get('/').set(headers)).body.address;

describe('the address of a request', () => {
  it('is the one that opened the socket when nothing is trusted', async () => {
    const app = serve();

    expect(await ask(app, { 'x-forwarded-for': '203.0.113.9' })).toBe('127.0.0.1');
  });

  it('is the one the proxy names, once that proxy is trusted', async () => {
    const app = serve('loopback');

    expect(await ask(app, { 'x-forwarded-for': '192.168.1.42' })).toBe('192.168.1.42');
  });

  it('stops at the first hop of a chain that is not trusted', async () => {
    // Only the loopback proxy is believed, so the chain is read from the right
    // and stops at 10.0.0.9: a hop nobody vouches for could have written
    // everything to its left. This is the shape of the mistake worth knowing —
    // trusting one proxy and expecting the client from a chain of three.
    const app = serve('loopback');

    expect(await ask(app, { 'x-forwarded-for': '192.168.1.42, 10.0.0.8, 10.0.0.9' })).toBe(
      '10.0.0.9'
    );
  });

  it('reaches the client once every hop in the chain is trusted', async () => {
    // What an installation behind a proxy in another container needs:
    // `loopback` alone never matches a bridge address like 172.18.0.1.
    const app = serve('loopback,uniquelocal');

    expect(await ask(app, { 'x-forwarded-for': '203.0.113.9, 172.18.0.5, 10.0.0.9' })).toBe(
      '203.0.113.9'
    );
  });

  it('reads X-Real-IP when that is all the proxy sends', async () => {
    // nginx's own example configuration sets this one and no other, which is
    // why Express alone leaves those installations naming the proxy.
    const app = serve('loopback');

    expect(await ask(app, { 'x-real-ip': '192.168.1.42' })).toBe('192.168.1.42');
  });

  it('will not take X-Real-IP from somebody who is not a proxy', async () => {
    const app = serve();

    expect(await ask(app, { 'x-real-ip': '203.0.113.9' })).toBe('127.0.0.1');
  });

  it('believes Cloudflare over anything else in front of it', async () => {
    // Behind a tunnel, `CF-Connecting-IP` names the person even when a hop has
    // added itself to the chain since; it is the one Cloudflare sets itself.
    const app = serve('loopback');

    expect(
      await ask(app, {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '10.248.0.7',
        'x-real-ip': '10.248.0.7',
      })
    ).toBe('203.0.113.9');
  });

  it("will not take Cloudflare's word from somebody who is not a proxy", async () => {
    const app = serve();

    expect(await ask(app, { 'cf-connecting-ip': '203.0.113.9' })).toBe('127.0.0.1');
  });

  it('prefers the forwarded chain to X-Real-IP when both are there', async () => {
    const app = serve('loopback');

    expect(await ask(app, { 'x-forwarded-for': '192.168.1.42', 'x-real-ip': '10.9.9.9' })).toBe(
      '192.168.1.42'
    );
  });
});

describe('an address wearing a dual-stack coat', () => {
  it('is written the way somebody reading the log would write it', () => {
    expect(normalizeAddress('::ffff:192.168.1.7')).toBe('192.168.1.7');
    expect(normalizeAddress('::FFFF:10.0.0.4')).toBe('10.0.0.4');
  });

  it('leaves a real IPv6 address alone', () => {
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeAddress('::1')).toBe('::1');
  });

  it('answers nothing rather than an empty string', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress({})).toBeNull();
  });
});

describe('a proxy nobody is listening to', () => {
  /** A request as it arrives from a proxy this server was not told to believe. */
  const fromAProxy = (forwarded = '192.168.1.42') => ({
    headers: { 'x-forwarded-for': forwarded },
    socket: { remoteAddress: '172.18.0.1' },
    app: { get: () => () => false },
  });

  it('is reported once, naming both addresses and what to do about it', async () => {
    const { warnAboutIgnoredForwarding } = await import('../../src/utils/clientAddress.js');

    const said = warnAboutIgnoredForwarding(fromAProxy());

    expect(said).toMatchObject({ announced: '192.168.1.42', recorded: '172.18.0.1' });
    expect(said.hint).toContain('TRUST_PROXY');
    // Once. Every request through that proxy carries the same header, and a
    // line per request would bury the log it is trying to explain.
    expect(warnAboutIgnoredForwarding(fromAProxy('192.168.1.43'))).toBeNull();
  });

  it('says nothing when the proxy is believed', async () => {
    const { warnAboutIgnoredForwarding } = await import('../../src/utils/clientAddress.js');

    expect(
      warnAboutIgnoredForwarding({
        ...fromAProxy(),
        app: { get: () => () => true },
      })
    ).toBeNull();
  });

  it('says nothing when nobody is announcing anything', async () => {
    const { warnAboutIgnoredForwarding } = await import('../../src/utils/clientAddress.js');

    expect(warnAboutIgnoredForwarding({ ...fromAProxy(), headers: {} })).toBeNull();
  });
});
