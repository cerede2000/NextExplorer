import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import ModalDialog from './ModalDialog.vue';

/**
 * Seven dialogs share this component, so what it exposes to assistive
 * technology (and to the keyboard) is what all of them expose.
 */
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { common: { close: 'Close' } } },
});

const mountDialog = (props = {}) =>
  mount(ModalDialog, {
    props: { modelValue: true, ...props },
    slots: { title: 'Edit favorite', default: '<button id="inner">Save</button>' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });

describe('ModalDialog accessibility', () => {
  it('announces itself as a dialog, labelled by its own title', () => {
    const wrapper = mountDialog();
    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy)?.textContent).toContain('Edit favorite');

    wrapper.unmount();
  });

  it('gives the close button an accessible name', () => {
    const wrapper = mountDialog();
    const closeButton = [...document.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.getAttribute('aria-label') === 'Close'
    );
    expect(closeButton).toBeTruthy();
    wrapper.unmount();
  });

  it('closes on Escape', async () => {
    const wrapper = mountDialog();
    const dialog = document.querySelector('[role="dialog"]');

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });
});

describe('ModalDialog focus handling', () => {
  it('does not steal focus from a field the dialog focused itself', async () => {
    const wrapper = mount(ModalDialog, {
      props: { modelValue: false },
      slots: { title: 'Password required', default: '<input id="pw" />' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });

    await wrapper.setProps({ modelValue: true });
    // Mimic a child dialog focusing its own input right after opening.
    document.getElementById('pw').focus();
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement?.id).toBe('pw');
    wrapper.unmount();
  });

  it('focuses the first control when nothing else claimed it', async () => {
    const wrapper = mount(ModalDialog, {
      props: { modelValue: true },
      slots: { title: 'Plain', default: '<button id="ok">OK</button>' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.contains(document.activeElement)).toBe(true);
    wrapper.unmount();
  });
});
