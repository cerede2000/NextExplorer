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

    // contains() would also accept the dialog container itself, which is not
    // what this promises: focus has to land on a real control.
    expect(document.activeElement?.tagName).toBe('BUTTON');
    wrapper.unmount();
  });
});

describe('ModalDialog keyboard trap', () => {
  const tab = (shiftKey = false) =>
    document
      .querySelector('[role="dialog"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));

  it('wraps from the last control back to the first', async () => {
    const wrapper = mountDialog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.getElementById('inner').focus();
    tab();

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    wrapper.unmount();
  });

  it('wraps backwards from the first control to the last', async () => {
    const wrapper = mountDialog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.querySelector('[role="dialog"] button').focus();
    tab(true);

    expect(document.activeElement?.id).toBe('inner');
    wrapper.unmount();
  });

  it('pulls focus back in when it sits on something outside the ring', async () => {
    // A hidden control is filtered out of the ring, so focus parked on it used
    // to match neither end and Tab walked straight out of the dialog.
    const wrapper = mount(ModalDialog, {
      props: { modelValue: true },
      slots: {
        title: 'Hidden',
        default: '<button id="visible">Save</button><button id="ghost" hidden>Ghost</button>',
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.getElementById('ghost').focus();
    tab();

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    wrapper.unmount();
  });
});
