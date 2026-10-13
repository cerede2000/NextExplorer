import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

import NewOfficeDocumentDialog from './NewOfficeDocumentDialog.vue';

/**
 * Naming a new document, and saying what happens next.
 *
 * The box used to have one button, "Create and open", which created the file
 * and then — for every type with no preview plugin, which is all the text ones
 * — opened nothing. Two buttons now, because they are two different wants: a
 * document named for later belongs in the folder, and one being written now
 * belongs in its editor. Which one was pressed is the only thing this box
 * knows that its caller does not, so it travels with the name.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { cancel: 'Cancel', close: 'Close', create: 'Create' },
      create: { documentName: 'Document name', createAndOpen: 'Create and open' },
    },
  },
});

// ModalDialog teleports to the body, so the box is inspected there rather than
// inside the wrapper.
let wrapper = null;

// Mounted shut and then opened, which is the only way it is ever opened in the
// application: the suggested name is filled in when the box opens, not when it
// is built, so a box that was already open on mount has no name in it.
const mountDialog = async (props = {}) => {
  wrapper = mount(NewOfficeDocumentDialog, {
    props: {
      modelValue: false,
      format: 'txt',
      title: 'New text file',
      defaultName: 'Document',
      ...props,
    },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
};

const button = (test) => document.querySelector(`button[data-test="${test}"]`);
const field = () => document.querySelector('input[type="text"]');
const form = () => document.querySelector('form');

const created = () => wrapper.emitted('create') || [];

const type = async (value) => {
  const input = field();
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the two ways out', () => {
  it('offers creating on its own as well as creating and opening', async () => {
    await mountDialog();

    expect(button('create-only')?.textContent.trim()).toBe('Create');
    expect(button('create-and-open')?.textContent.trim()).toBe('Create and open');
  });

  it('asks for the document to be opened when that is the button pressed', async () => {
    await mountDialog({ format: 'md' });

    button('create-and-open').click();
    await flushPromises();

    expect(created()).toEqual([[{ format: 'md', name: 'Document', open: true }]]);
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
  });

  it('asks only for it to be created when that is the button pressed', async () => {
    await mountDialog({ format: 'md' });

    button('create-only').click();
    await flushPromises();

    expect(created()).toEqual([[{ format: 'md', name: 'Document', open: false }]]);
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
  });

  // Enter is the form's own submit, and the form's button is the opening one:
  // somebody who typed a name and pressed Enter is about to start writing.
  it('opens the document when the name is submitted with the keyboard', async () => {
    await mountDialog();
    await type('Shopping list');

    form().dispatchEvent(new Event('submit', { cancelable: true }));
    await flushPromises();

    expect(created()).toEqual([[{ format: 'txt', name: 'Shopping list', open: true }]]);
  });

  it('creates nothing under a name that is only spaces, either way', async () => {
    await mountDialog();
    await type('   ');

    expect(button('create-only').disabled).toBe(true);
    expect(button('create-and-open').disabled).toBe(true);

    button('create-only').click();
    await flushPromises();

    expect(created()).toEqual([]);
  });
});
