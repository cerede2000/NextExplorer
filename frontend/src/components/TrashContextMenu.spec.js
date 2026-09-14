import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('@floating-ui/vue', () => ({
  useFloating: () => ({
    floatingStyles: { position: 'fixed', left: '0px', top: '0px' },
    update: vi.fn(),
  }),
  autoUpdate: vi.fn(),
  flip: vi.fn(),
  offset: vi.fn(),
  shift: vi.fn(),
}));

import TrashContextMenu from './TrashContextMenu.vue';

/**
 * The trash's right-click menu. It shows the entries it is given and says which
 * one was chosen. What matters is that it closes whichever way someone leaves
 * it, never runs an entry that is switched off, and works without a mouse.
 */

const sections = [
  [
    { id: 'open', label: 'Open' },
    { id: 'preview', label: 'Preview', disabled: true },
  ],
  [],
  [{ id: 'restore', label: 'Restore' }],
  [{ id: 'delete', label: 'Delete permanently', danger: true }],
];

let wrapper;

const mountMenu = async (props = {}) => {
  wrapper = mount(TrashContextMenu, {
    props: { open: true, x: 40, y: 60, sections, label: 'Actions for report.txt', ...props },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
};

const menu = () => document.body.querySelector('[data-test="trash-context-menu"]');
const entries = () => [...document.body.querySelectorAll('[role="menuitem"]')];
const press = (key) =>
  menu().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the trash context menu', () => {
  it('shows its entries in groups, named for what they act on', async () => {
    await mountMenu();

    expect(menu().getAttribute('aria-label')).toBe('Actions for report.txt');
    expect(entries().map((entry) => entry.textContent.trim())).toEqual([
      'Open',
      'Preview',
      'Restore',
      'Delete permanently',
    ]);
    // An empty group leaves no rule behind.
    expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  it('shows nothing while closed', async () => {
    await mountMenu({ open: false });

    expect(menu()).toBeNull();
  });

  it('says which entry was chosen, and closes', async () => {
    await mountMenu();

    entries()[2].click();

    expect(wrapper.emitted('select')).toEqual([['restore']]);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('never runs an entry that is switched off', async () => {
    await mountMenu();

    entries()[1].click();

    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('closes on a click outside it, and not on a click inside', async () => {
    await mountMenu();

    menu().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('closes on Escape', async () => {
    await mountMenu();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('is used from the keyboard, passing over what is switched off', async () => {
    await mountMenu();
    const [open, , restore, remove] = entries();

    expect(document.activeElement).toBe(open);
    press('ArrowDown');
    expect(document.activeElement).toBe(restore);
    press('End');
    expect(document.activeElement).toBe(remove);
    press('Home');
    expect(document.activeElement).toBe(open);
    press('ArrowUp');
    expect(document.activeElement).toBe(remove);
    press('Tab');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('gives the focus back to where it was once it closes', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    await mountMenu();
    expect(document.activeElement).not.toBe(before);

    await wrapper.setProps({ open: false });
    await flushPromises();

    expect(document.activeElement).toBe(before);
  });
});
