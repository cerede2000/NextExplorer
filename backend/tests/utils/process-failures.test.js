import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { installProcessFailureHandlers } = require('../../src/utils/processFailures.js');

/**
 * What a failure nobody caught costs.
 *
 * A forgotten `await` on the personal-path resolver left a containment refusal
 * with no listener, and Node's default for an unhandled rejection is to stop
 * the process. One bad path took the whole server down — a price out of all
 * proportion to a request that should simply have been answered "no".
 *
 * Attached to a stand-in emitter rather than the real process: a test that
 * installed the real handlers would either kill its own runner or silence the
 * runner's own reporting of unhandled rejections, which is the thing keeping
 * this class of defect visible during development.
 */

const setup = ({ onFatal = vi.fn(), shutdownTimeoutMs = 50 } = {}) => {
  const target = new EventEmitter();
  const log = { error: vi.fn() };
  const exit = vi.fn();
  const uninstall = installProcessFailureHandlers({
    log,
    onFatal,
    exit,
    shutdownTimeoutMs,
    target,
  });
  return { target, log, exit, onFatal, uninstall };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('a promise rejected with nobody listening', () => {
  it('is reported', async () => {
    const { target, log } = setup();

    target.emit('unhandledRejection', new Error('outside the configured user directory'));

    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('is reported with the error itself, so the stack survives', async () => {
    const { target, log } = setup();
    const reason = new Error('outside the configured user directory');

    target.emit('unhandledRejection', reason);

    expect(log.error.mock.calls[0][0].err).toBe(reason);
  });

  /** A rejection can carry anything; a log entry should still have a stack. */
  it('makes an error out of something that was not one', async () => {
    const { target, log } = setup();

    target.emit('unhandledRejection', 'just a string');

    expect(log.error.mock.calls[0][0].err).toBeInstanceOf(Error);
    expect(log.error.mock.calls[0][0].err.message).toBe('just a string');
  });

  /** The whole point: the request fails, the server does not. */
  it('does not stop the process', async () => {
    const { target, exit } = setup();

    target.emit('unhandledRejection', new Error('one bad path'));
    await settle();

    expect(exit).not.toHaveBeenCalled();
  });

  it('does not shut anything down', async () => {
    const { target, onFatal } = setup();

    target.emit('unhandledRejection', new Error('one bad path'));
    await settle();

    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('an uncaught exception', () => {
  /**
   * Not the same thing, and deliberately not treated the same way: the stack
   * unwound through code that had no chance to put anything back, so what is in
   * memory afterwards cannot be trusted.
   */
  it('is reported', async () => {
    const { target, log } = setup();

    target.emit('uncaughtException', new Error('torn'));

    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('shuts the server down', async () => {
    const { target, onFatal } = setup();

    target.emit('uncaughtException', new Error('torn'));
    await settle();

    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('ends the process', async () => {
    const { target, exit } = setup();

    target.emit('uncaughtException', new Error('torn'));
    await settle();

    expect(exit).toHaveBeenCalledWith(1);
  });

  /**
   * The shutdown runs in the same unknown state that caused this, so it may
   * never finish. The process ends anyway.
   */
  it('ends the process even when the shutdown hangs', async () => {
    const { target, exit } = setup({ onFatal: () => new Promise(() => {}) });

    target.emit('uncaughtException', new Error('torn'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ends the process when the shutdown itself fails', async () => {
    const { target, exit, log } = setup({
      onFatal: () => Promise.reject(new Error('cleanup broke too')),
    });

    target.emit('uncaughtException', new Error('torn'));
    await settle();

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  /** Once, however many ways it gets there. */
  it('does not end the process twice', async () => {
    const { target, exit } = setup({ shutdownTimeoutMs: 5 });

    target.emit('uncaughtException', new Error('torn'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('taking the handlers off again', () => {
  it('leaves nothing listening', async () => {
    const { target, uninstall, log } = setup();

    uninstall();
    target.emit('unhandledRejection', new Error('after'));

    expect(log.error).not.toHaveBeenCalled();
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });
});
