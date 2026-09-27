import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * Deleting with the trash on: what the confirmation sends, and to where.
 *
 * The rule is that nothing is removed for good without the person having been
 * told. Items the server announced as permanent go in a permanent request;
 * everything else goes to the trash; what the trash still turns away is kept
 * and asked about again.
 */

const getDeleteImpact = vi.fn();
const deleteNow = vi.fn();
let selected;

vi.mock('@/api', () => ({
  getDeleteImpact: (...args) => getDeleteImpact(...args),
  normalizePath: (value = '') => String(value).replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/composables/fileActions', () => ({
  useFileActions: () => ({ selectedItems: selected, canDelete: ref(true), deleteNow }),
}));

const REPORT = { name: 'report.txt', path: 'Projects', kind: 'txt' };
const VIDEO = { name: 'rushes.mov', path: 'Projects', kind: 'mov' };

/** The composable is a singleton: each test gets a fresh module. */
const setup = async (items) => {
  vi.resetModules();
  selected = ref(items);
  const { useDeleteConfirm } = await import('./useDeleteConfirm');
  const confirm = useDeleteConfirm();
  confirm.openDeleteConfirm();
  await vi.waitFor(() => expect(confirm.isLoadingDeleteImpact.value).toBe(false));
  return confirm;
};

const trashImpact = (items, { enabled = true } = {}) => ({
  shareCount: 0,
  shares: [],
  trash: { enabled, retentionDays: 30, items },
});

const sent = () =>
  deleteNow.mock.calls.map(([items, options]) => ({
    names: items.map((item) => item.name),
    permanent: options?.permanent === true,
  }));

beforeEach(() => {
  getDeleteImpact.mockReset();
  deleteNow.mockReset();
  deleteNow.mockResolvedValue({ success: true, items: [] });
});

describe('what the confirmation knows before anyone confirms', () => {
  it('that everything goes to the trash', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/rushes.mov', disposition: 'trash', reason: null },
      ])
    );
    const confirm = await setup([REPORT, VIDEO]);

    expect(confirm.trashPlan.value).toMatchObject({
      enabled: true,
      retentionDays: 30,
      permanent: [],
      reasons: [],
    });
    expect(confirm.trashPlan.value.toTrash.map((item) => item.name)).toEqual([
      'report.txt',
      'rushes.mov',
    ]);
  });

  it('which items would be gone for good, and why', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/rushes.mov', disposition: 'permanent', reason: 'too-large' },
      ])
    );
    const confirm = await setup([REPORT, VIDEO]);

    expect(confirm.trashPlan.value.permanent.map((item) => item.name)).toEqual(['rushes.mov']);
    expect(confirm.trashPlan.value.reasons).toEqual(['too-large']);
  });

  it('that everything is permanent while the trash is off', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([{ path: 'Projects/report.txt', disposition: 'permanent', reason: 'disabled' }], {
        enabled: false,
      })
    );
    const confirm = await setup([REPORT]);

    expect(confirm.trashPlan.value).toMatchObject({ enabled: false, toTrash: [] });
    expect(confirm.trashPlan.value.permanent.map((item) => item.name)).toEqual(['report.txt']);
  });

  it('how many earlier versions go with what is not coming back', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact(
        [
          {
            path: 'Projects/report.txt',
            disposition: 'permanent',
            reason: 'disabled',
            versionCount: 3,
            versionBytes: 900,
          },
          {
            path: 'Projects/rushes.mov',
            disposition: 'permanent',
            reason: 'disabled',
            versionCount: 1,
            versionBytes: 100,
          },
        ],
        { enabled: false }
      )
    );
    const confirm = await setup([REPORT, VIDEO]);

    expect(confirm.trashPlan.value).toMatchObject({ versions: 4, versionBytes: 1000 });
  });

  it('leaves out the versions of what is only going to the trash', async () => {
    // They go with the file and come back with it, so counting them among
    // what is about to be destroyed would be a warning about nothing.
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null, versionCount: 7 },
        {
          path: 'Projects/rushes.mov',
          disposition: 'permanent',
          reason: 'too-large',
          versionCount: 2,
          versionBytes: 50,
        },
      ])
    );
    const confirm = await setup([REPORT, VIDEO]);

    expect(confirm.trashPlan.value).toMatchObject({ versions: 2, versionBytes: 50 });
  });

  it('none, when nothing that is going has any', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([{ path: 'Projects/report.txt', disposition: 'permanent', reason: 'disabled' }], {
        enabled: false,
      })
    );
    const confirm = await setup([REPORT]);

    expect(confirm.trashPlan.value.versions).toBe(0);
  });

  it('nothing, when the server could not be asked', async () => {
    getDeleteImpact.mockRejectedValue(new Error('offline'));
    const confirm = await setup([REPORT]);

    expect(confirm.trashPlan.value).toBeNull();
  });
});

describe('what confirming sends', () => {
  it('everything to the trash when everything can go there', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/rushes.mov', disposition: 'trash', reason: null },
      ])
    );
    const confirm = await setup([REPORT, VIDEO]);

    await confirm.confirmDelete();

    expect(sent()).toEqual([{ names: ['report.txt', 'rushes.mov'], permanent: false }]);
    expect(confirm.isDeleteConfirmOpen.value).toBe(false);
  });

  it('what was announced as permanent in a permanent request, the rest to the trash', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/rushes.mov', disposition: 'permanent', reason: 'other-device' },
      ])
    );
    const confirm = await setup([REPORT, VIDEO]);

    await confirm.confirmDelete();

    expect(sent()).toEqual([
      { names: ['report.txt'], permanent: false },
      { names: ['rushes.mov'], permanent: true },
    ]);
  });

  it('everything for good when the person chose to delete permanently', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([{ path: 'Projects/report.txt', disposition: 'trash', reason: null }])
    );
    const confirm = await setup([REPORT]);

    await confirm.confirmDelete({ permanent: true });

    expect(sent()).toEqual([{ names: ['report.txt'], permanent: true }]);
  });

  /** The dialog said nothing, so nothing is sent as permanent: the server decides. */
  it('a plain request when the server could not say what the trash would do', async () => {
    getDeleteImpact.mockRejectedValue(new Error('offline'));
    const confirm = await setup([REPORT]);

    await confirm.confirmDelete();

    expect(sent()).toEqual([{ names: ['report.txt'], permanent: false }]);
  });

  it('a plain request when the trash is off, as the server removes them anyway', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([{ path: 'Projects/report.txt', disposition: 'permanent', reason: 'disabled' }], {
        enabled: false,
      })
    );
    const confirm = await setup([REPORT]);

    await confirm.confirmDelete();

    expect(sent()).toEqual([{ names: ['report.txt'], permanent: false }]);
  });
});

describe('what the trash still turns away', () => {
  const setupKept = async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/rushes.mov', disposition: 'trash', reason: null },
      ])
    );
    deleteNow.mockResolvedValueOnce({
      success: true,
      items: [
        { path: 'Projects/report.txt', status: 'trashed', trashItemId: 't1' },
        {
          path: 'Projects/rushes.mov',
          status: 'kept',
          reason: 'too-large',
          size: 50,
          budgetBytes: 20,
        },
      ],
    });
    const confirm = await setup([REPORT, VIDEO]);
    await confirm.confirmDelete();
    return confirm;
  };

  it('is kept, with why, and asked about again', async () => {
    const confirm = await setupKept();

    expect(confirm.isKeptConfirmOpen.value).toBe(true);
    expect(confirm.keptItems.value).toEqual([
      {
        name: 'rushes.mov',
        path: 'Projects',
        kind: 'mov',
        reason: 'too-large',
        size: 50,
        budgetBytes: 20,
      },
    ]);
  });

  it('is deleted for good once the person says so', async () => {
    const confirm = await setupKept();
    deleteNow.mockClear();

    await confirm.confirmKept();

    expect(sent()).toEqual([{ names: ['rushes.mov'], permanent: true }]);
    expect(confirm.isKeptConfirmOpen.value).toBe(false);
  });

  it('stays where it is when the person declines', async () => {
    const confirm = await setupKept();
    deleteNow.mockClear();

    confirm.closeKeptConfirm();

    expect(confirm.isKeptConfirmOpen.value).toBe(false);
    expect(deleteNow).not.toHaveBeenCalled();
  });

  it('is nothing to ask about when everything went to the trash', async () => {
    getDeleteImpact.mockResolvedValue(
      trashImpact([{ path: 'Projects/report.txt', disposition: 'trash', reason: null }])
    );
    deleteNow.mockResolvedValueOnce({
      success: true,
      items: [{ path: 'Projects/report.txt', status: 'trashed' }],
    });
    const confirm = await setup([REPORT]);

    await confirm.confirmDelete();

    expect(confirm.isKeptConfirmOpen.value).toBe(false);
  });
});
