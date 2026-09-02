import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

vi.mock('@vueuse/core', () => ({
  useStorage: (_key, initial) => ref(JSON.parse(JSON.stringify(initial))),
}));

import { useNotificationsStore } from './notifications';

/**
 * The notification list, and the toasts that float off it.
 *
 * A toast is not a separate thing: it is a notification young enough to still
 * be shown. So the lifetime is computed from a timestamp on every read, which
 * makes it the one part worth pinning — a toast that never expires covers the
 * file listing, and one that expires immediately is a message nobody sees.
 *
 * The list is persisted, so it also has to be bounded in two directions: a cap
 * on how many are kept, and an age past which they go. Neither had a test.
 */

let store;

const at = (isoOffsetMs) => new Date(Date.now() - isoOffsetMs).toISOString();

/** Push a notification and then backdate it, since toasts age by wall clock. */
const aged = (notification, ageMs) => {
  const id = store.addNotification(notification);
  const entry = store.notifications.find((n) => n.id === id);
  entry.timestamp = at(ageMs);
  return id;
};

beforeEach(() => {
  setActivePinia(createPinia());
  store = useNotificationsStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adding one', () => {
  it('keeps what was given and fills in the rest', () => {
    const id = store.addNotification({ type: 'error', heading: 'Upload failed', body: 'Timed out' });

    const entry = store.notifications.find((n) => n.id === id);
    expect(entry).toMatchObject({
      type: 'error',
      heading: 'Upload failed',
      body: 'Timed out',
      read: false,
      toastDismissed: false,
    });
    expect(entry.timestamp).toBeTruthy();
    expect(entry.iconName).toBeTruthy();
  });

  it('defaults to info when no type is given', () => {
    const id = store.addNotification({ heading: 'Done' });

    expect(store.notifications.find((n) => n.id === id).type).toBe('info');
  });

  /** An unknown type must still get an icon, or the row renders blank. */
  it('falls back to the info icon for a type it does not know', () => {
    const id = store.addNotification({ type: 'catastrophe', heading: 'Hmm' });

    expect(store.notifications.find((n) => n.id === id).iconName).toBe('InformationCircleIcon');
  });

  it('gives an error longer on screen than a success', () => {
    const error = store.addNotification({ type: 'error', heading: 'a' });
    const success = store.addNotification({ type: 'success', heading: 'b' });

    const find = (id) => store.notifications.find((n) => n.id === id).durationMs;
    expect(find(error)).toBeGreaterThan(find(success));
  });

  it('honours an explicit duration, including zero', () => {
    const id = store.addNotification({ type: 'error', heading: 'a', durationMs: 0 });

    expect(store.notifications.find((n) => n.id === id).durationMs).toBe(0);
  });

  it('hands back an id that is not the same twice', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => store.addNotification({ heading: 'x' }))
    );

    expect(ids.size).toBe(50);
  });
});

describe('the toasts that show', () => {
  it('shows a fresh one', () => {
    store.addNotification({ type: 'info', heading: 'Fresh' });

    expect(store.activeToasts.map((n) => n.heading)).toEqual(['Fresh']);
  });

  it('stops showing one older than its own duration', () => {
    aged({ type: 'success', heading: 'Old' }, 60_000);

    expect(store.activeToasts).toHaveLength(0);
  });

  /** Errors linger longer, so the same age keeps one and drops the other. */
  it('keeps an error at an age that has already dropped a success', () => {
    aged({ type: 'success', heading: 'Gone' }, 4_000);
    aged({ type: 'error', heading: 'Still here' }, 4_000);

    expect(store.activeToasts.map((n) => n.heading)).toEqual(['Still here']);
  });

  it('stops showing one that was dismissed by hand, however fresh', () => {
    const id = store.addNotification({ type: 'error', heading: 'Dismissed' });

    store.dismissToast(id);

    expect(store.activeToasts).toHaveLength(0);
    // Dismissing the toast must not remove it from the panel.
    expect(store.notifications.find((n) => n.id === id)).toBeTruthy();
  });

  it('hides a type the person has filtered out', () => {
    store.addNotification({ type: 'info', heading: 'Chatter' });

    store.filters.info = false;

    expect(store.activeToasts).toHaveLength(0);
  });

  /** More than a handful stacked up covers the listing they describe. */
  it('shows at most five, keeping the newest', () => {
    for (let i = 0; i < 9; i += 1) store.addNotification({ type: 'error', heading: `n${i}` });

    expect(store.activeToasts).toHaveLength(5);
    expect(store.activeToasts.at(-1).heading).toBe('n8');
  });
});

describe('the panel list', () => {
  it('counts only the unread', () => {
    const first = store.addNotification({ heading: 'a' });
    store.addNotification({ heading: 'b' });

    store.markAsRead(first);

    expect(store.unreadCount).toBe(1);
  });

  it('marks everything read at once', () => {
    store.addNotification({ heading: 'a' });
    store.addNotification({ heading: 'b' });

    store.markAllAsRead();

    expect(store.unreadCount).toBe(0);
  });

  it('filters the list the same way it filters toasts', () => {
    store.addNotification({ type: 'error', heading: 'bad' });
    store.addNotification({ type: 'info', heading: 'chatter' });

    store.filters.info = false;

    expect(store.filteredNotifications.map((n) => n.heading)).toEqual(['bad']);
  });

  it('removes one by id and leaves the others', () => {
    const first = store.addNotification({ heading: 'a' });
    store.addNotification({ heading: 'b' });

    store.removeNotification(first);

    expect(store.notifications.map((n) => n.heading)).toEqual(['b']);
  });

  it('shrugs at removing an id that is not there', () => {
    store.addNotification({ heading: 'a' });

    expect(() => store.removeNotification('no-such-id')).not.toThrow();
    expect(store.notifications).toHaveLength(1);
  });

  it('clears the lot', () => {
    store.addNotification({ heading: 'a' });
    store.addNotification({ heading: 'b' });

    store.clearAll();

    expect(store.notifications).toHaveLength(0);
  });
});

describe('keeping the stored list bounded', () => {
  /** It is persisted, so an unbounded list is a growing thing in localStorage. */
  it('caps the list, keeping the newest', () => {
    for (let i = 0; i < 130; i += 1) store.addNotification({ heading: `n${i}` });

    expect(store.notifications).toHaveLength(100);
    expect(store.notifications[0].heading).toBe('n30');
    expect(store.notifications.at(-1).heading).toBe('n129');
  });

  it('prunes anything older than a week', () => {
    aged({ heading: 'ancient' }, 8 * 24 * 60 * 60 * 1000);
    aged({ heading: 'recent' }, 2 * 24 * 60 * 60 * 1000);

    store.pruneOld();

    expect(store.notifications.map((n) => n.heading)).toEqual(['recent']);
  });

  it('keeps one that is just under a week old', () => {
    aged({ heading: 'six days' }, 6 * 24 * 60 * 60 * 1000);

    store.pruneOld();

    expect(store.notifications).toHaveLength(1);
  });
});

describe('copying an error out', () => {
  it('writes the heading and body to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { ...globalThis.window, isSecureContext: true });
    const id = store.addNotification({ type: 'error', heading: 'Upload failed', body: 'Timed out' });

    const copied = await store.copyNotification(id);

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Upload failed'));
    vi.unstubAllGlobals();
  });

  it('answers false for an id that is not there', async () => {
    expect(await store.copyNotification('no-such-id')).toBe(false);
  });
});
