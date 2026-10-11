import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { createUnreadableWarning } from './unreadable';

/**
 * What an operation says when it could not read everything.
 *
 * The server skips an entry whose name does not decode rather than failing the
 * whole copy over it, which is right — and said nothing about it, which was
 * not. A copy missing files, reported as done, is how somebody loses the only
 * other version of them.
 */
describe('what an operation says about the entries it could not read', () => {
  const store = () => ({ addNotification: vi.fn() });

  it('says nothing when everything was read', () => {
    const notifications = store();

    expect(createUnreadableWarning(notifications)({ items: [] })).toBe(false);
    expect(notifications.addNotification).not.toHaveBeenCalled();
  });

  it('says nothing for an answer from a server that does not count them', () => {
    const notifications = store();

    createUnreadableWarning(notifications)({ items: [{ from: 'a', to: 'b' }] });

    expect(notifications.addNotification).not.toHaveBeenCalled();
  });

  it('warns once, with the count, when something was left out', () => {
    const notifications = store();

    createUnreadableWarning(notifications)({ unreadable: 3, items: [] });

    expect(notifications.addNotification).toHaveBeenCalledTimes(1);
    const [notification] = notifications.addNotification.mock.calls[0];
    expect(notification.type).toBe('warning');
    expect(notification.body).toContain('3');
  });

  /**
   * A move keeps its source when its copy is short of something, because the
   * source holds the only copy of what could not be read. Saying only "3
   * entries could not be read" would send somebody looking for a folder that is
   * still exactly where they left it.
   */
  it('says the original stayed, when a move kept it', () => {
    const notifications = store();

    createUnreadableWarning(notifications)({
      unreadable: 1,
      items: [{ from: 'From/Work', to: 'To/Work', unreadable: 1, sourceKept: true }],
    });

    const [notification] = notifications.addNotification.mock.calls[0];
    // Asked of the catalogue rather than written out here, so rewording the
    // sentence does not turn into a failing test about nothing.
    expect(notification.body).toContain(i18n.global.t('transfers.unreadableSourceKept'));
  });

  it('does not say it for a copy, which never removes anything', () => {
    const notifications = store();

    createUnreadableWarning(notifications)({
      unreadable: 1,
      items: [{ from: 'From/Work', to: 'To/Work', unreadable: 1 }],
    });

    const [notification] = notifications.addNotification.mock.calls[0];
    expect(notification.body).not.toContain(i18n.global.t('transfers.unreadableSourceKept'));
  });
});
