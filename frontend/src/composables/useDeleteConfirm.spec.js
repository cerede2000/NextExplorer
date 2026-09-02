import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The confirmation in front of a delete.
 *
 * Sixty-three statements at 1.6%, guarding the one action in the explorer that
 * nothing undoes. Three of its behaviours are the reason it exists rather than
 * a plain `confirm()`:
 *
 * It freezes the selection when the dialog opens. The live selection is cleared
 * when somebody browses elsewhere, and the dialog stays up — so reading the
 * live one at confirm time deletes whatever happens to be selected then, or
 * nothing at all.
 *
 * It filters volumes out. A volume is a mount, not a file; sending one to the
 * delete endpoint asks the server to remove somebody's storage.
 *
 * And the "what will this break" lookup is racy by nature — open, close, reopen
 * on a different selection — so a late answer must not overwrite a newer one.
 */

const getDeleteImpact = vi.fn();

vi.mock('@/api', () => ({
  getDeleteImpact: (...args) => getDeleteImpact(...args),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));

let actions;
vi.mock('@/composables/fileActions', () => ({ useFileActions: () => actions }));

const { ref } = await import('vue');

const FILE = { name: 'report.txt', path: 'Docs', kind: 'txt' };
const VOLUME = { name: 'Media', path: '', kind: 'volume' };

const makeActions = ({ selection = [FILE], canDelete = true } = {}) => ({
  selectedItems: ref(selection),
  canDelete: ref(canDelete),
  deleteNow: vi.fn().mockResolvedValue(),
});

/** The composable is a singleton, so each test needs the module built again. */
const freshConfirm = async (options) => {
  vi.resetModules();
  actions = makeActions(options);
  const { useDeleteConfirm } = await import('./useDeleteConfirm');
  return useDeleteConfirm();
};

beforeEach(() => {
  getDeleteImpact.mockReset();
  getDeleteImpact.mockResolvedValue({ shareCount: 0, shares: [] });
});

describe('opening it', () => {
  it('opens with the selection captured', async () => {
    const confirm = await freshConfirm();

    confirm.openDeleteConfirm();

    expect(confirm.isDeleteConfirmOpen.value).toBe(true);
    expect(confirm.pendingDeleteItems.value).toEqual([
      expect.objectContaining({ name: 'report.txt', path: 'Docs' }),
    ]);
  });

  it('does not open when deleting is not allowed here', async () => {
    const confirm = await freshConfirm({ canDelete: false });

    confirm.openDeleteConfirm();

    expect(confirm.isDeleteConfirmOpen.value).toBe(false);
  });

  it('does not open on an empty selection', async () => {
    const confirm = await freshConfirm({ selection: [] });

    confirm.openDeleteConfirm();

    expect(confirm.isDeleteConfirmOpen.value).toBe(false);
  });

  /** A volume is a mount. Sending one to the delete endpoint is not a file op. */
  it('drops volumes from what will be deleted', async () => {
    const confirm = await freshConfirm({ selection: [FILE, VOLUME] });

    confirm.openDeleteConfirm();

    expect(confirm.pendingDeleteItems.value.map((i) => i.name)).toEqual(['report.txt']);
  });

  it('does not open when the selection is volumes and nothing else', async () => {
    const confirm = await freshConfirm({ selection: [VOLUME] });

    confirm.openDeleteConfirm();

    expect(confirm.isDeleteConfirmOpen.value).toBe(false);
  });

  it('drops an entry with no name, which nothing could resolve', async () => {
    const confirm = await freshConfirm({ selection: [FILE, { path: 'Docs' }] });

    confirm.openDeleteConfirm();

    expect(confirm.pendingDeleteItems.value).toHaveLength(1);
  });

  it('carries the editing-activity hint through to the store', async () => {
    const busy = { ...FILE, onlyofficeActivity: { users: ['alice'] } };
    const confirm = await freshConfirm({ selection: [busy] });

    confirm.openDeleteConfirm();

    expect(confirm.pendingDeleteItems.value[0].onlyofficeActivity).toEqual({ users: ['alice'] });
  });

  it('requestDelete is the same door', async () => {
    const confirm = await freshConfirm();

    confirm.requestDelete();

    expect(confirm.isDeleteConfirmOpen.value).toBe(true);
  });
});

describe('what the delete will break', () => {
  it('shows the shares that will stop working', async () => {
    getDeleteImpact.mockResolvedValue({ shareCount: 2, shares: [{ id: 'a' }, { id: 'b' }] });
    const confirm = await freshConfirm();

    confirm.openDeleteConfirm();
    await vi.waitFor(() => expect(confirm.isLoadingDeleteImpact.value).toBe(false));

    expect(confirm.deleteImpact.value.shareCount).toBe(2);
  });

  it('asks about the frozen list, not the live selection', async () => {
    const confirm = await freshConfirm();

    confirm.openDeleteConfirm();

    expect(getDeleteImpact).toHaveBeenCalledWith(confirm.pendingDeleteItems.value);
  });

  it('reports a lookup that fails without blocking the delete', async () => {
    getDeleteImpact.mockRejectedValue(new Error('server unreachable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const confirm = await freshConfirm();

    confirm.openDeleteConfirm();
    await vi.waitFor(() => expect(confirm.isLoadingDeleteImpact.value).toBe(false));

    expect(confirm.deleteImpactError.value).toBe('server unreachable');
    expect(confirm.isDeleteConfirmOpen.value).toBe(true);
    error.mockRestore();
  });

  /**
   * Open, close, reopen on a different selection: the first lookup can land
   * after the second and would otherwise describe the wrong files.
   */
  it('ignores an answer that arrives after the dialog was closed', async () => {
    let settleFirst;
    getDeleteImpact.mockReturnValueOnce(new Promise((resolve) => (settleFirst = resolve)));
    const confirm = await freshConfirm();

    confirm.openDeleteConfirm();
    confirm.closeDeleteConfirm();
    settleFirst({ shareCount: 9, shares: [{ id: 'stale' }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(confirm.deleteImpact.value.shareCount).toBe(0);
    expect(confirm.isLoadingDeleteImpact.value).toBe(false);
  });

  it('does not ask at all when there is nothing pending', async () => {
    const confirm = await freshConfirm({ selection: [] });

    confirm.openDeleteConfirm();

    expect(getDeleteImpact).not.toHaveBeenCalled();
  });
});

describe('confirming', () => {
  it('deletes the frozen list and tells the store the warning was shown', async () => {
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();
    const frozen = confirm.pendingDeleteItems.value;

    await confirm.confirmDelete();

    expect(actions.deleteNow).toHaveBeenCalledWith(frozen, { onlyofficeWarningShown: true });
  });

  /**
   * The point of freezing. Browsing away clears the live selection while the
   * dialog is still up; confirming must still delete what it asked about.
   */
  it('deletes what it asked about even after the selection was cleared', async () => {
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();

    actions.selectedItems.value = [];
    await confirm.confirmDelete();

    expect(actions.deleteNow.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'report.txt' }),
    ]);
  });

  it('closes the dialog before the delete rather than after', async () => {
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();
    let openDuringDelete = null;
    actions.deleteNow.mockImplementation(async () => {
      openDuringDelete = confirm.isDeleteConfirmOpen.value;
    });

    await confirm.confirmDelete();

    expect(openDuringDelete).toBe(false);
  });

  it('does nothing when there is nothing pending', async () => {
    const confirm = await freshConfirm();

    await confirm.confirmDelete();

    expect(actions.deleteNow).not.toHaveBeenCalled();
  });

  /** A double click on Delete must not send the operation twice. */
  it('refuses a second confirm while the first is running', async () => {
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();
    let release;
    actions.deleteNow.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const first = confirm.confirmDelete();
    await confirm.confirmDelete();
    release();
    await first;

    expect(actions.deleteNow).toHaveBeenCalledTimes(1);
  });

  it('clears the busy flag when the delete fails, so it can be retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();
    actions.deleteNow.mockRejectedValue(new Error('permission denied'));

    await confirm.confirmDelete();

    expect(confirm.isDeleting.value).toBe(false);
    error.mockRestore();
  });

  it('keeps the pending list after a failure rather than losing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();
    actions.deleteNow.mockRejectedValue(new Error('permission denied'));

    await confirm.confirmDelete();

    expect(confirm.pendingDeleteItems.value).toHaveLength(1);
    error.mockRestore();
  });
});

describe('closing', () => {
  it('forgets the pending list and the impact', async () => {
    const confirm = await freshConfirm();
    confirm.openDeleteConfirm();

    confirm.closeDeleteConfirm();

    expect(confirm.isDeleteConfirmOpen.value).toBe(false);
    expect(confirm.pendingDeleteItems.value).toEqual([]);
    expect(confirm.deleteImpact.value).toEqual({ shareCount: 0, shares: [] });
    expect(confirm.deleteImpactError.value).toBe('');
  });
});

describe('the shared instance', () => {
  /**
   * A menu item and a keyboard shortcut both call this. Two instances would put
   * two dialogs on screen, each holding half the state.
   */
  it('is the same object for every caller', async () => {
    vi.resetModules();
    actions = makeActions();
    const { useDeleteConfirm } = await import('./useDeleteConfirm');

    expect(useDeleteConfirm()).toBe(useDeleteConfirm());
  });
});
