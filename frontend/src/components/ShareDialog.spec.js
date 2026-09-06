import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useAppSettings } from '@/stores/appSettings';
import { createI18n } from 'vue-i18n';

/**
 * What a share is actually created with.
 *
 * This dialog is where somebody decides who may reach a file and what they may
 * do with it, and CI measures it at sixteen per cent. The payload it builds is
 * the whole of that decision: get a field wrong and a share grants something
 * nobody asked for, silently, and stays that way until somebody notices.
 *
 * Reading an existing share back into the form is the same risk in reverse.
 * Opening a share to rename it must not quietly change its permissions on the
 * way through.
 */

const createShare = vi.fn(async (data) => ({ ...data, id: 'share-1', shareToken: 'tok' }));
const updateShare = vi.fn(async (id, data) => ({ ...data, id }));
const copyShareUrl = vi.fn(async () => true);
const copyDirectShareFileUrl = vi.fn(async () => true);
const fetchShareableUsers = vi.fn(async () => ({
  users: [
    { id: 'u-1', username: 'alice', displayName: 'Alice' },
    { id: 'u-2', username: 'bob', displayName: 'Bob' },
  ],
}));

vi.mock('@/api/shares.api', () => ({
  createShare: (...args) => createShare(...args),
  updateShare: (...args) => updateShare(...args),
  copyShareUrl: (...args) => copyShareUrl(...args),
  copyDirectShareFileUrl: (...args) => copyDirectShareFileUrl(...args),
  getDirectShareFileUrl: vi.fn(() => 'https://files.example.com/d/tok'),
  DIRECT_SHARE_FILE_MODES: [
    { value: 'auto', labelKey: 'share.directLinkModes.auto', fallback: 'Auto' },
    { value: 'editor', labelKey: 'share.directLinkModes.editor', fallback: 'Editor' },
    { value: 'download', labelKey: 'share.directLinkModes.download', fallback: 'Download' },
  ],
}));

vi.mock('@/api/users.api', () => ({
  fetchShareableUsers: (...args) => fetchShareableUsers(...args),
}));

// The date picker reaches for the DOM and a stylesheet, and decides nothing
// tested here: the dialog reads `expiresAtDate`, which these set directly.
vi.mock('flatpickr', () => ({ default: vi.fn(() => ({ destroy: vi.fn(), setDate: vi.fn() })) }));
vi.mock('flatpickr/dist/flatpickr.min.css', () => ({}));

const ShareDialog = (await import('./ShareDialog.vue')).default;

const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false });

const FILE = { name: 'report.pdf', path: 'Docs', kind: 'pdf' };
const FOLDER = { name: 'Docs', path: '', kind: 'directory' };

/**
 * Opened the way every parent opens it: mounted closed, then switched on.
 *
 * The dialog fills its form from a `watch` on the open flag, so a wrapper
 * mounted already-open would sit there empty and every assertion below would be
 * about nothing.
 */
const open = async (props = {}) => {
  const wrapper = mount(ShareDialog, {
    props: { modelValue: false, item: FILE, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
};

/** The form's own state, which is what the payload is built from. */
const form = (wrapper) => wrapper.vm;

const submit = async (wrapper) => {
  await form(wrapper).submitShare();
  await flushPromises();
};

const sentToCreate = () => createShare.mock.calls.at(-1)?.[0];
const sentToUpdate = () => updateShare.mock.calls.at(-1)?.[1];

beforeEach(() => {
  setActivePinia(createPinia());
  createShare.mockClear();
  updateShare.mockClear();
  fetchShareableUsers.mockClear();
  copyShareUrl.mockClear();
  copyDirectShareFileUrl.mockClear();
});

describe('a share created with the defaults', () => {
  it('is read-only', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate().accessMode).toBe('readonly');
  });

  it('is open to anyone with the link', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate().sharingType).toBe('anyone');
  });

  /** Everything permitted until somebody says otherwise, download included. */
  it('permits everything a share can permit', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate()).toMatchObject({
      allowDelete: true,
      allowDownload: true,
      allowCreateFolder: true,
      allowCreateFile: true,
      allowUpload: true,
    });
  });

  it('has no password and no expiry', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate()).toMatchObject({ password: null, expiresAt: null });
  });

  it('carries the path of the item it was opened on', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate().sourcePath).toBe('Docs/report.pdf');
  });
});

describe('a share whose permissions were changed', () => {
  it('sends the download refusal', async () => {
    const wrapper = await open();
    form(wrapper).allowDownload = false;

    await submit(wrapper);

    expect(sentToCreate().allowDownload).toBe(false);
  });

  it('sends the other refusals as they were set', async () => {
    const wrapper = await open({ item: FOLDER });
    Object.assign(form(wrapper), {
      accessMode: 'readwrite',
      allowDelete: false,
      allowUpload: false,
    });

    await submit(wrapper);

    expect(sentToCreate()).toMatchObject({
      accessMode: 'readwrite',
      allowDelete: false,
      allowUpload: false,
    });
  });
});

describe('a share restricted to named people', () => {
  it('carries the people it was restricted to', async () => {
    const wrapper = await open();
    Object.assign(form(wrapper), { sharingType: 'users', selectedUserIds: ['u-1', 'u-2'] });

    await submit(wrapper);

    expect(sentToCreate().userIds).toEqual(['u-1', 'u-2']);
  });

  it('is refused with nobody chosen', async () => {
    const wrapper = await open();
    form(wrapper).sharingType = 'users';

    await submit(wrapper);

    expect(createShare).not.toHaveBeenCalled();
    expect(form(wrapper).error).toBeTruthy();
  });

  /**
   * A link open to anyone carries a password; a share named to people does not.
   * Sending one anyway would leave it to apply again if the share were later
   * made public.
   */
  it('carries no list of people when it is open to anyone', async () => {
    const wrapper = await open();
    Object.assign(form(wrapper), { sharingType: 'anyone', selectedUserIds: ['u-1'] });

    await submit(wrapper);

    expect(sentToCreate().userIds).toEqual([]);
  });
});

describe('a share that expires', () => {
  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  it('carries the moment it expires', async () => {
    const wrapper = await open();
    const when = tomorrow();
    Object.assign(form(wrapper), { enableExpiry: true, expiresAtDate: when });

    await submit(wrapper);

    expect(sentToCreate().expiresAt).toBe(when.toISOString());
  });

  /** An expiry already past would create a share nobody can open. */
  it('is refused when the moment has already passed', async () => {
    const wrapper = await open();
    Object.assign(form(wrapper), {
      enableExpiry: true,
      expiresAtDate: new Date(Date.now() - 1000),
    });

    await submit(wrapper);

    expect(createShare).not.toHaveBeenCalled();
    expect(form(wrapper).error).toMatch(/future/i);
  });

  it('is refused when no moment was chosen', async () => {
    const wrapper = await open();
    Object.assign(form(wrapper), { enableExpiry: true, expiresAtDate: null });

    await submit(wrapper);

    expect(createShare).not.toHaveBeenCalled();
  });
});

describe('opening an existing share to edit it', () => {
  const existing = {
    id: 'share-9',
    accessMode: 'readwrite',
    sharingType: 'anyone',
    isDirectory: true,
    allowDownload: false,
    allowDelete: false,
    allowCreateFolder: true,
    allowCreateFile: true,
    allowUpload: true,
    label: 'Quarterly',
    hasPassword: true,
  };

  it('reads its permissions back into the form', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });

    expect(form(wrapper).allowDownload).toBe(false);
    expect(form(wrapper).allowDelete).toBe(false);
    expect(form(wrapper).accessMode).toBe('readwrite');
  });

  /**
   * The round trip that matters: opening a share and saving it again must send
   * back what it already had, not the defaults.
   */
  it('sends them back unchanged when nothing was touched', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });

    await submit(wrapper);

    expect(sentToUpdate()).toMatchObject({
      allowDownload: false,
      allowDelete: false,
      accessMode: 'readwrite',
    });
  });

  /** A permission that is off is one somebody has to be able to see. */
  it('opens the advanced panel when one of its permissions is off', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });

    expect(form(wrapper).showAdvancedPermissions).toBe(true);
  });

  it('leaves it closed for a share with nothing unusual', async () => {
    const wrapper = await open({
      share: { ...existing, allowDelete: true, allowDownload: true },
      item: FOLDER,
    });

    expect(form(wrapper).showAdvancedPermissions).toBe(false);
  });

  /**
   * Its password is only re-sent when somebody typed one. Otherwise saving a
   * rename would clear a password that is still wanted.
   */
  it('says nothing about the password when it was not touched', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });

    await submit(wrapper);

    expect('password' in sentToUpdate()).toBe(false);
  });

  it('clears it when the share is narrowed to named people', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });
    Object.assign(form(wrapper), { sharingType: 'users', selectedUserIds: ['u-1'] });

    await submit(wrapper);

    expect(sentToUpdate().password).toBeNull();
  });

  it('sends a new one when somebody typed it', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });
    Object.assign(form(wrapper), { passwordDirty: true, enablePassword: true, password: 'hunter2' });

    await submit(wrapper);

    expect(sentToUpdate().password).toBe('hunter2');
  });

  it('creates nothing when it is editing', async () => {
    const wrapper = await open({ share: existing, item: FOLDER });

    await submit(wrapper);

    expect(createShare).not.toHaveBeenCalled();
    expect(updateShare).toHaveBeenCalledTimes(1);
  });
});

describe('when the server refuses', () => {
  it('says so rather than pretending it worked', async () => {
    createShare.mockRejectedValueOnce(new Error('Share limit reached'));
    const wrapper = await open();

    await submit(wrapper);

    expect(form(wrapper).error).toBe('Share limit reached');
  });

  it('stops showing itself as busy', async () => {
    createShare.mockRejectedValueOnce(new Error('nope'));
    const wrapper = await open();

    await submit(wrapper);

    expect(form(wrapper).isCreating).toBe(false);
  });
});

describe('the expiry a site has set as its default', () => {
  const setDefault = (defaultShareExpiration) => {
    useAppSettings().userSettings = { defaultShareExpiration };
  };

  it('is applied to a new share', async () => {
    setDefault({ value: 7, unit: 'days' });
    const wrapper = await open();

    await submit(wrapper);

    const days = (new Date(sentToCreate().expiresAt) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  /**
   * An existing share keeps the expiry it was given. Applying the site default
   * on the way through would move — or invent — the expiry of a share somebody
   * only opened to rename.
   */
  it('is not applied to a share being edited', async () => {
    setDefault({ value: 7, unit: 'days' });
    const wrapper = await open({ share: { id: 'share-9', sharingType: 'anyone' } });

    await submit(wrapper);

    expect(sentToUpdate().expiresAt).toBeNull();
  });

  it('leaves a new share unexpiring when there is no default', async () => {
    setDefault(null);
    const wrapper = await open();

    await submit(wrapper);

    expect(sentToCreate().expiresAt).toBeNull();
  });

  it('reads back the expiry an edited share already had', async () => {
    const when = new Date(Date.now() + 3 * 86400000);
    const wrapper = await open({
      share: { id: 'share-9', sharingType: 'anyone', expiresAt: when.toISOString() },
    });

    await submit(wrapper);

    expect(sentToUpdate().expiresAt).toBe(when.toISOString());
  });
});

describe('choosing who a share is for', () => {
  it('adds somebody who was clicked', async () => {
    const wrapper = await open();
    form(wrapper).sharingType = 'users';
    await flushPromises();

    form(wrapper).toggleUserSelection('u-2');
    await submit(wrapper);

    expect(sentToCreate().userIds).toEqual(['u-2']);
  });

  it('removes somebody who was clicked again', async () => {
    const wrapper = await open();
    form(wrapper).sharingType = 'users';
    await flushPromises();

    form(wrapper).toggleUserSelection('u-1');
    form(wrapper).toggleUserSelection('u-2');
    form(wrapper).toggleUserSelection('u-1');
    await submit(wrapper);

    expect(sentToCreate().userIds).toEqual(['u-2']);
  });

  it('asks the server for the people it can offer, once', async () => {
    const wrapper = await open();
    form(wrapper).sharingType = 'users';
    await flushPromises();
    form(wrapper).sharingType = 'anyone';
    await flushPromises();
    form(wrapper).sharingType = 'users';
    await flushPromises();

    expect(fetchShareableUsers).toHaveBeenCalledTimes(1);
  });
});

describe('the direct link offered once a share exists', () => {
  /** A link that opens the editor on a PDF would open nothing at all. */
  it('offers the editor only for a file the editor can open', async () => {
    const pdf = await open();
    expect(form(pdf).directLinkModeOptions.map((mode) => mode.value)).not.toContain('editor');

    const markdown = await open({ item: { name: 'notes.md', path: 'Docs', kind: 'file' } });
    expect(form(markdown).directLinkModeOptions.map((mode) => mode.value)).toContain('editor');
  });

  it('copies the token of the share that was just created', async () => {
    const wrapper = await open();
    await submit(wrapper);

    await form(wrapper).copyLink();

    expect(copyShareUrl).toHaveBeenCalledWith('tok');
    expect(form(wrapper).linkCopied).toBe(true);
  });

  it('copies the direct link in the mode that was chosen', async () => {
    const wrapper = await open();
    await submit(wrapper);
    form(wrapper).directLinkMode = 'download';

    await form(wrapper).copyDirectLink();

    expect(copyDirectShareFileUrl).toHaveBeenCalledWith('tok', '', 'download');
  });

  it('copies nothing before a share exists', async () => {
    const wrapper = await open();

    await form(wrapper).copyLink();
    await form(wrapper).copyDirectLink();

    expect(copyShareUrl).not.toHaveBeenCalled();
    expect(copyDirectShareFileUrl).not.toHaveBeenCalled();
  });
});

describe('what the dialog tells the page around it', () => {
  it('announces the share it created and stays open to show the link', async () => {
    const wrapper = await open();

    await submit(wrapper);

    expect(wrapper.emitted('shareCreated')?.[0]?.[0]).toMatchObject({ shareToken: 'tok' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('announces the share it changed and closes', async () => {
    const wrapper = await open({ share: { id: 'share-9', sharingType: 'anyone' } });

    await submit(wrapper);

    expect(wrapper.emitted('shareUpdated')?.[0]?.[0]).toMatchObject({ id: 'share-9' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });
});
