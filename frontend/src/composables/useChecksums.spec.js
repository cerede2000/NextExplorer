import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Asking what a file's bytes add up to.
 *
 * Reading a file to the end is the slowest thing the application does to one it
 * is not moving, so it goes through the panel's own registration like every
 * other long operation: a bar while it reads, a cancel that asks the server,
 * and a reading that outlives the tab.
 *
 * And the two gestures are one call with one difference — one file to see what
 * it is, two or three to learn whether they are the same thing under different
 * names.
 */

const { fetchKnownChecksums, takeChecksums } = vi.hoisted(() => ({
  fetchKnownChecksums: vi.fn(),
  takeChecksums: vi.fn(),
}));

vi.mock('@/api', () => ({ fetchKnownChecksums, takeChecksums }));

const onEvent = vi.fn();
const onTask = vi.fn();
const finish = vi.fn();
const startServerOperation = vi.fn(() => ({ id: 'op-1', onEvent, onTask, finish }));
const addNotification = vi.fn();

vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({ startServerOperation }),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification }),
}));

const { useChecksums } = await import('./useChecksums');

const t = (key, values) => (values ? `${key}(${Object.values(values).join('|')})` : key);
const FILES = [
  { path: 'Docs', name: 'a.txt' },
  { path: 'Docs', name: 'b.txt' },
];

beforeEach(() => {
  fetchKnownChecksums.mockReset();
  takeChecksums.mockReset();
  startServerOperation.mockClear();
  onEvent.mockReset();
  onTask.mockReset();
  finish.mockReset();
  addNotification.mockReset();
  takeChecksums.mockResolvedValue({ items: [], identical: null });
});

describe('what is already known', () => {
  it('is asked for without reading anything', async () => {
    fetchKnownChecksums.mockResolvedValue({ digests: { sha256: 'abc' } });

    const answer = await useChecksums().known('Docs/a.txt');

    expect(fetchKnownChecksums).toHaveBeenCalledWith('Docs/a.txt');
    expect(answer.digests.sha256).toBe('abc');
    expect(takeChecksums).not.toHaveBeenCalled();
  });

  // A file nobody may ask about has nothing to show, which is not a refusal to
  // put on the screen: there is nothing the reader could do with it.
  it('is nothing at all when the question is refused', async () => {
    fetchKnownChecksums.mockRejectedValue(new Error('Cannot read that file.'));

    expect(await useChecksums().known('Docs/a.txt')).toBeNull();
  });
});

describe('taking them', () => {
  it('goes through the panel, which is what makes it stoppable', async () => {
    await useChecksums().take([FILES[0]], { name: 'a.txt' });

    expect(startServerOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checksum', itemCount: 1, name: 'a.txt' })
    );
    expect(takeChecksums).toHaveBeenCalledWith(
      [FILES[0]],
      expect.objectContaining({ onEvent, onTask })
    );
    expect(finish).toHaveBeenCalled();
  });

  it('takes the panel entry away however it ends', async () => {
    takeChecksums.mockRejectedValue(new Error('disk is unreadable'));

    await expect(useChecksums().take([FILES[0]])).rejects.toThrow('disk is unreadable');
    expect(finish).toHaveBeenCalled();
  });

  // Stopping one is what the reader asked for, not a failure to report.
  it('answers nothing when it was stopped', async () => {
    takeChecksums.mockRejectedValue(
      Object.assign(new Error('Cancelled.'), { code: 'OPERATION_CANCELLED' })
    );

    expect(await useChecksums().take([FILES[0]])).toBeNull();
    expect(finish).toHaveBeenCalled();
  });

  it('does nothing when there is nothing to read', async () => {
    expect(await useChecksums().take([])).toBeNull();
    expect(startServerOperation).not.toHaveBeenCalled();
  });

  // One reading at a time from one screen: the button is pressed twice before
  // the first answer comes back more often than anyone would like.
  it('refuses a second reading while one is running', async () => {
    const checksums = useChecksums();
    let release = () => {};
    takeChecksums.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [] });
        })
    );

    const first = checksums.take([FILES[0]]);
    const second = await checksums.take([FILES[0]]);
    release();
    await first;

    expect(second).toBeNull();
    expect(takeChecksums).toHaveBeenCalledTimes(1);
  });
});

describe('comparing files', () => {
  it('says they are the same when the server says so', async () => {
    takeChecksums.mockResolvedValue({
      identical: true,
      items: [{ name: 'a.txt' }, { name: 'b.txt' }],
    });

    await useChecksums().compare(FILES, { t });

    expect(takeChecksums).toHaveBeenCalledWith(FILES, expect.objectContaining({ compare: true }));
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', heading: 'checksums.same' })
    );
  });

  it('says they are not, and names them', async () => {
    takeChecksums.mockResolvedValue({
      identical: false,
      items: [{ name: 'a.txt' }, { name: 'b.txt' }],
    });

    await useChecksums().compare(FILES, { t });

    const told = addNotification.mock.calls[0][0];
    expect(told.heading).toBe('checksums.different');
    expect(told.body).toBe('a.txt · b.txt');
  });

  /**
   * And says why, where the answer cost nothing: two files of different sizes
   * are different, and the server read neither of them to say so.
   */
  it('says the sizes already answered it', async () => {
    takeChecksums.mockResolvedValue({
      identical: false,
      because: 'size',
      items: [{ name: 'a.txt' }, { name: 'b.txt' }],
    });

    await useChecksums().compare(FILES, { t });

    expect(addNotification.mock.calls[0][0].body).toBe('checksums.differentSizes');
  });

  it('says nothing when the comparison was stopped', async () => {
    takeChecksums.mockRejectedValue(
      Object.assign(new Error('Cancelled.'), { code: 'OPERATION_CANCELLED' })
    );

    expect(await useChecksums().compare(FILES, { t })).toBeNull();
    expect(addNotification).not.toHaveBeenCalled();
  });
});
