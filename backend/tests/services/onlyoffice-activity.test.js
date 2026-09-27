import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../src/services/onlyofficeActivityService');

/**
 * Presence says "somebody is editing this right now", and it is shown to
 * everyone browsing the folder. Two ways to get it wrong:
 *
 *  - claim it too early. It used to be recorded when the editor asked for its
 *    configuration, which happens before anyone knows the document will open —
 *    a file the editor refused stayed marked as being edited until it expired.
 *    It is now recorded on the first heartbeat, which the client only starts
 *    once ONLYOFFICE reports the document ready.
 *  - announce it too often. Presence changes wake every browser waiting on a
 *    long poll, and the heartbeat fires every sixty seconds per open document.
 */

let activity;
beforeEach(() => {
  delete require.cache[modulePath];
  activity = require(modulePath);
});

const FILE = '/volume/report.docx';
const USER = { id: 'u1', name: 'Alice' };

describe('ONLYOFFICE presence', () => {
  it('reports nobody until a session declares itself', () => {
    expect(activity.get(FILE)).toBeNull();
  });

  it('records the document as open on the first heartbeat', () => {
    activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });

    expect(activity.get(FILE)).toMatchObject({ active: true, count: 1, users: ['Alice'] });
  });

  it('announces a change once, not on every heartbeat', () => {
    const before = activity.getVersion();
    activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });
    const afterFirst = activity.getVersion();

    for (let i = 0; i < 10; i += 1) {
      activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });
    }

    expect(afterFirst).toBeGreaterThan(before);
    // Ten more beats, still one announcement: waking every open browser once a
    // minute per document is the cost this avoids.
    expect(activity.getVersion()).toBe(afterFirst);
  });

  it('keeps the name from the first beat when later ones omit it', () => {
    activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });
    activity.touch({ absolutePath: FILE, sessionId: 's1' });

    expect(activity.get(FILE).users).toEqual(['Alice']);
  });

  it('counts two people editing the same document', () => {
    activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });
    activity.touch({ absolutePath: FILE, sessionId: 's2', user: { id: 'u2', name: 'Bob' } });

    const presence = activity.get(FILE);
    expect(presence.count).toBe(2);
    expect(presence.users.sort()).toEqual(['Alice', 'Bob']);
  });

  it('forgets a session when its editor closes', () => {
    activity.touch({ absolutePath: FILE, sessionId: 's1', user: USER });
    activity.close({ absolutePath: FILE, sessionId: 's1' });

    expect(activity.get(FILE)).toBeNull();
  });

  it('ignores a beat with nothing to identify it', () => {
    expect(activity.touch({ absolutePath: FILE })).toBe(false);
    expect(activity.touch({ sessionId: 's1' })).toBe(false);
    expect(activity.get(FILE)).toBeNull();
  });
});
