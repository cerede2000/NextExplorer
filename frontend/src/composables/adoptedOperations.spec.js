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

const { forgetTaskNews, fetchUnfinishedUploads } = vi.hoisted(() => ({
  forgetTaskNews: vi.fn(),
  fetchUnfinishedUploads: vi.fn(),
}));
const guestSessionId = ref(null);

vi.mock('@/api', () => ({
  forgetTaskNews,
  fetchUnfinishedUploads,
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

const show = ({
  signedIn = true,
  answer = { items: [], interrupted: [], unreported: [] },
  path = 'Docs',
} = {}) => {
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
  forgetTaskNews.mockReset();
  forgetTaskNews.mockResolvedValue({ forgotten: 1 });
  fetchUnfinishedUploads.mockReset();
  fetchUnfinishedUploads.mockResolvedValue([]);
  sessionStorage.clear();
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

describe('the news nobody gave this reader', () => {
  const lost = {
    items: [],
    interrupted: [
      {
        id: 'lost-1',
        kind: 'move',
        destination: 'Archive/2026',
        paths: ['Docs/a.txt', 'Docs/b.txt'],
      },
      { id: 'lost-2', kind: 'delete', destination: 'Photos', paths: ['Photos/old.jpg'] },
    ],
    unreported: [
      { id: 'done-1', kind: 'copy', outcome: 'done', destination: 'Archive/2026' },
      { id: 'done-2', kind: 'compress', outcome: 'done', name: 'bundle.zip' },
      { id: 'bad-1', kind: 'delete', outcome: 'failed', destination: 'Photos' },
    ],
  };

  /**
   * One notification per piece of news, not per operation: five finished copies
   * are one line and five items, where five notifications are five things to
   * dismiss.
   */
  it('is told in one notification per kind of news, and only once', async () => {
    show({ answer: lost });
    await looked();

    const told = notifications.addNotification.mock.calls.map(([one]) => one);
    expect(told).toHaveLength(3);

    const interrupted = told.find((one) => one.type === 'warning');
    expect(interrupted.heading).toBe('transfers.interruptedHeading(2)');
    expect(interrupted.body).toContain('transfers.interruptedBody');
    expect(interrupted.body).toContain('Docs/a.txt, Docs/b.txt, Photos/old.jpg');
    expect(interrupted.body).toContain('transfers.newsKindMove → Archive/2026');
    expect(interrupted.body).toContain('transfers.newsKindDelete → Photos');

    const finished = told.find((one) => one.type === 'success');
    expect(finished.heading).toBe('transfers.finishedHeading(2)');
    expect(finished.body).toContain('transfers.newsKindCopy → Archive/2026');
    // An archive says the name it took rather than the folder it went into.
    expect(finished.body).toContain('transfers.newsKindCompress → bundle.zip');

    // A failure nobody saw is the news worth most, and it is said as one.
    const failed = told.find((one) => one.type === 'error');
    expect(failed.heading).toBe('transfers.failedHeading(1)');
    expect(failed.body).toContain('transfers.newsKindDelete → Photos');

    expect(forgetTaskNews).toHaveBeenCalledWith(['lost-1', 'lost-2', 'done-1', 'done-2', 'bad-1']);
  });

  it('says nothing about a kind of news there is none of', async () => {
    show({
      answer: {
        items: [],
        interrupted: [],
        unreported: [{ id: 'done-1', kind: 'copy', outcome: 'done', destination: 'Archive' }],
      },
    });
    await looked();

    const told = notifications.addNotification.mock.calls.map(([one]) => one);
    expect(told.map((one) => one.type)).toEqual(['success']);
  });

  it('says nothing, and forgets nothing, when there is none at all', async () => {
    show();
    await looked();

    expect(notifications.addNotification).not.toHaveBeenCalled();
    expect(forgetTaskNews).not.toHaveBeenCalled();
  });
});

describe('an adopted operation that ends', () => {
  it('says so, and refreshes the folder it filled up', async () => {
    const { settle } = show({ path: 'Archive/2026' });
    await looked();

    settle({ kind: 'copy', destination: 'Archive/2026', result: { destination: 'Archive/2026' } });

    expect(notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', heading: 'transfers.finishedHeading(1)' })
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

/**
 * And the files that did not arrive, which are news of the same kind told a
 * different way.
 *
 * An upload cannot be taken over by the server: the bytes are in the browser, so
 * when the tab goes away nobody is sending any. There is nothing to adopt and
 * nothing to acknowledge — the file is either finished or it is not — so what
 * the reader needs is to be told, and told once per tab for as long as the
 * server is still holding the part that arrived.
 */
describe('an upload that did not arrive in full', () => {
  const halfSent = [
    { id: 'u1', name: 'film.mkv', size: 1000, offset: 400, uploadTo: 'Docs' },
    { id: 'u2', name: 'disk.img', size: 2000, offset: 0, uploadTo: 'Docs' },
  ];

  it('is told in one notification, with how far each of them got', async () => {
    fetchUnfinishedUploads.mockResolvedValue(halfSent);
    show();
    await looked();

    const told = notifications.addNotification.mock.calls
      .map(([one]) => one)
      .filter((one) => String(one.heading).startsWith('upload.'));
    expect(told).toHaveLength(1);
    expect(told[0].heading).toBe('upload.notArrivedHeading(2)');
    expect(told[0].body).toContain('upload.notArrivedBody');
    expect(told[0].body).toContain('film.mkv (40%)');
    // Nothing of it arrived, which is still worth saying by name.
    expect(told[0].body).toContain('disk.img (0%)');
  });

  it('is not said twice in one tab', async () => {
    fetchUnfinishedUploads.mockResolvedValue(halfSent);
    const first = show();
    await looked();
    expect(notifications.addNotification).toHaveBeenCalledTimes(1);

    // The same tab looking again — a sign-in, a share's password typed.
    await first.look?.();
    notifications.addNotification.mockClear();
    auth.isAuthenticated = false;
    await looked();
    auth.isAuthenticated = true;
    await looked();

    expect(notifications.addNotification).not.toHaveBeenCalled();
  });

  it('says the new one when another upload stops later', async () => {
    fetchUnfinishedUploads.mockResolvedValue([halfSent[0]]);
    show();
    await looked();
    notifications.addNotification.mockClear();

    fetchUnfinishedUploads.mockResolvedValue(halfSent);
    auth.isAuthenticated = false;
    await looked();
    auth.isAuthenticated = true;
    await looked();

    const told = notifications.addNotification.mock.calls.map(([one]) => one);
    expect(told).toHaveLength(1);
    expect(told[0].heading).toBe('upload.notArrivedHeading(1)');
    expect(told[0].body).toContain('disk.img');
    expect(told[0].body).not.toContain('film.mkv');
  });

  it('says nothing when everything arrived', async () => {
    show();
    await looked();

    expect(notifications.addNotification).not.toHaveBeenCalled();
  });

  // A browser that refuses session storage is told again rather than not at all.
  it('still says it where nothing can be remembered', async () => {
    fetchUnfinishedUploads.mockResolvedValue([halfSent[0]]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    show();
    await looked();

    expect(notifications.addNotification).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
