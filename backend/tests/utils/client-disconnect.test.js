import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { whenClientDisconnects } = require('../../src/utils/clientDisconnect');

/**
 * Every abandoned search went on running for its full budget. `close` fires on
 * a finished response too, so telling the two apart is the whole job: a
 * promise that settles when a response ends normally would cancel the search
 * that is about to answer.
 */
const response = (writableEnded = false) => Object.assign(new EventEmitter(), { writableEnded });

describe('noticing that nobody is waiting any more', () => {
  it('settles when the connection closes with nothing written', async () => {
    const res = response();
    const gone = whenClientDisconnects(res);
    let settled = false;
    gone.then(() => (settled = true));

    res.emit('close');
    await Promise.resolve();

    expect(settled).toBe(true);
  });

  it('stays pending when the response closes because it answered', async () => {
    const res = response();
    const gone = whenClientDisconnects(res);
    const settled = vi.fn();
    gone.then(settled);

    res.writableEnded = true;
    res.emit('close');
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });

  it('never settles for a response that had already finished', async () => {
    const settled = vi.fn();
    whenClientDisconnects(response(true)).then(settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });
});
