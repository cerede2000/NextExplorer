import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, reactive, ref } from 'vue';

/**
 * Taking up the operations this reader already has running, and saying what a
 * restart took.
 *
 * A copy runs in the server and outlives the tab that asked for it, which left
 * the other half missing: a tab opened afterwards knew nothing about it, so a
 * transfer of twenty gigabytes was invisible until it was over.
 *
 * And nothing is resumed across a restart, by design — half a copy is a state on
 * disk. So the person who started one is told what was in flight, with the
 * paths, rather than left to find half of it at the destination.
 */

const { forgetInterruptedTasks } = vi.hoisted(() => ({ forgetInterruptedTasks: vi.fn() }));
const guestSessionId = ref(null);

vi.mock('@/api', () => ({
  forgetInterruptedTasks,
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/api/guestSession', () => ({ guestSessionId }));

let auth;
let fileStore;
let notifications;
let operations;

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => notifications }));
vi.mock('@/stores/operationTasks', () => ({ useOperationTasksStore: () => operations }));
vi.mock('vue-i18n', () => ({
  // The real catalogue is not what is under test; what is, is that every string
  // on screen comes from one, with the values filled in.
  useI18n: () => ({
    t: (key, values) => (values ? `${key}(${Object.values(values).join('|')})` : key),
  }),
}));

const { useAdoptedOperations } = await import('./adoptedOperations');

const Shell = defineComponent({
  setup() {
    useAdoptedOperations();
    return () => null;
  },
});

let wrapper = null;
let settleListeners;

const show = ({ signedIn = true, answer = { items: [], interrupted: [] }, path = 'Docs' } = {}) => {
  settleListeners = [];
  auth = reactive({ isAuthenticated: signedIn });
  fileStore = reactive({
    currentPath: path,
    fetchPathItems: vi.fn(async () => {}),
    refreshSizes: vi.fn(),
  });
  notifications = { addNotification: vi.fn() };
  operations = {
    adoptServerOperations: vi.fn(async () => answer),
    whenAdoptedSettles: (listener) => {
      settleListeners.push(listener);
      return () => {};
    },
  };
  wrapper = mount(Shell);
  return { settle: (report) => settleListeners.forEach((listener) => listener(report)) };
};

/** Let the look settle: it is one request and its answer. */
const looked = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  forgetInterruptedTasks.mockReset();
  forgetInterruptedTasks.mockResolvedValue({ forgotten: 1 });
  guestSessionId.value = null;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the operations already running when a tab opens', () => {
  it('are asked for as soon as there is somebody to ask on behalf of', async () => {
    show();
    await looked();

    expect(operations.adoptServerOperations).toHaveBeenCalledTimes(1);
  });

  /**
   * And not before. A page drawn for nobody — the sign-in screen, a share whose
   * password has not been typed — would be asking a question that can only be
   * refused, and a refusal on that screen is a red notice about something the
   * reader can do nothing about.
   */
  it('are not asked for when nobody is reading yet', async () => {
    show({ signedIn: false });
    await looked();

    expect(operations.adoptServerOperations).not.toHaveBeenCalled();
  });

  it('are asked for once somebody signs in', async () => {
    show({ signedIn: false });
    await looked();

    auth.isAuthenticated = true;
    await looked();

    expect(operations.adoptServerOperations).toHaveBeenCalledTimes(1);
  });

  // A visitor holding a share's session is somebody too: their copy into a
  // shared folder outlives their tab exactly as an account's does.
  it('are asked for on behalf of a visitor who typed a share’s password', async () => {
    show({ signedIn: false });
    await looked();

    guestSessionId.value = 'guest-1';
    await looked();

    expect(operations.adoptServerOperations).toHaveBeenCalledTimes(1);
  });

  it('are left alone when asking fails, rather than put on the screen as a refusal', async () => {
    show();
    operations.adoptServerOperations.mockRejectedValue(new Error('offline'));
    auth.isAuthenticated = false;
    await looked();
    auth.isAuthenticated = true;
    await looked();

    expect(notifications.addNotification).not.toHaveBeenCalled();
  });
});

describe('what a restart interrupted', () => {
  const lost = {
    items: [],
    interrupted: [
      {
        id: 'lost-1',
        kind: 'move',
        destination: 'Archive/2026',
        paths: ['Docs/a.txt', 'Docs/b.txt'],
      },
    ],
  };

  it('is told once, with where it was going and what it was carrying', async () => {
    show({ answer: lost });
    await looked();

    expect(notifications.addNotification).toHaveBeenCalledTimes(1);
    const told = notifications.addNotification.mock.calls[0][0];
    expect(told.type).toBe('warning');
    expect(told.heading).toBe('transfers.interruptedMove');
    expect(told.body).toContain('Archive/2026');
    expect(told.body).toContain('Docs/a.txt, Docs/b.txt');

    // Told, and no longer waiting to be: the record is given once.
    expect(forgetInterruptedTasks).toHaveBeenCalledWith(['lost-1']);
  });

  it('says nothing, and forgets nothing, when there was none', async () => {
    show();
    await looked();

    expect(notifications.addNotification).not.toHaveBeenCalled();
    expect(forgetInterruptedTasks).not.toHaveBeenCalled();
  });
});

describe('an adopted operation that ends', () => {
  it('says so, and refreshes the folder it filled up', async () => {
    const { settle } = show({ path: 'Archive/2026' });
    await looked();

    settle({ kind: 'copy', destination: 'Archive/2026', result: { destination: 'Archive/2026' } });

    expect(notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', heading: 'transfers.finishedCopy' })
    );
    expect(fileStore.fetchPathItems).toHaveBeenCalledWith('Archive/2026');
  });

  // Only that folder: a reader who walked away mid-transfer is not sent back.
  it('leaves a reader who is somewhere else where they are', async () => {
    const { settle } = show({ path: 'Photos' });
    await looked();

    settle({ kind: 'copy', destination: 'Archive/2026', result: { destination: 'Archive/2026' } });

    expect(fileStore.fetchPathItems).not.toHaveBeenCalled();
  });

  it('says nothing of its own when it ended badly, which is already reported', async () => {
    const { settle } = show();
    await looked();

    settle({ kind: 'copy', destination: 'Archive', error: new Error('no room left') });

    expect(notifications.addNotification).not.toHaveBeenCalled();
  });
});
