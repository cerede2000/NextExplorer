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
      create: {
        documentName: 'Document name',
        documentExtension: 'Extension',
        createAndOpen: 'Create and open',
      },
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
const extensionField = () => document.querySelector('[data-test="document-extension"]');
const willBeCalled = () =>
  document.querySelector('[data-test="document-will-be-called"]')?.textContent.trim();
const form = () => document.querySelector('form');

const created = () => wrapper.emitted('create') || [];

const typeInto = async (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
};

const type = (value) => typeInto(field(), value);

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

  it('says what the document will be called as it is typed', async () => {
    await mountDialog({ chooseExtension: true });
    await type('settings');
    await typeInto(extensionField(), 'json');

    expect(willBeCalled()).toBe('settings.json');
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

/**
 * The extension, where it is the reader's to choose.
 *
 * The menu's text entries were three of the fifty extensions the editor opens,
 * so a `.json` or a `.sh` had to be made as a `.txt` and renamed in the
 * listing. It is a field now — for the formats made from no template, and only
 * those: an office document's extension is decided by the bytes of its
 * template, and a name that disagrees with them is a file no editor opens.
 */
describe('the extension', () => {
  it('is a field prefilled with the format, for a document with no template', async () => {
    await mountDialog({ format: 'txt', chooseExtension: true });

    expect(extensionField()).not.toBeNull();
    expect(extensionField().value).toBe('txt');
    expect(willBeCalled()).toBe('Document.txt');
  });

  it('is shown and fixed for a document made from a template', async () => {
    await mountDialog({ format: 'docx', chooseExtension: false });

    expect(extensionField()).toBeNull();
    expect(document.body.textContent).toContain('.docx');
  });

  it('travels with the name when it was typed', async () => {
    await mountDialog({ format: 'txt', chooseExtension: true });
    await type('settings');
    await typeInto(extensionField(), 'yml');

    button('create-and-open').click();
    await flushPromises();

    expect(created()).toEqual([
      [{ format: 'txt', name: 'settings', extension: 'yml', open: true }],
    ]);
  });

  // A leading dot is how most people write an extension, and typing one into a
  // field already labelled with one would otherwise make `notes..md`.
  it('reads a leading dot as the one already there', async () => {
    await mountDialog({ format: 'md', chooseExtension: true });
    await type('notes');
    await typeInto(extensionField(), '.md');

    expect(willBeCalled()).toBe('notes.md');
  });

  // Which is how a `Dockerfile` is asked for. Empty is a request, not a gap, so
  // it is sent rather than dropped — the server reads it as "no extension".
  it('is sent empty when it was emptied', async () => {
    await mountDialog({ format: 'txt', chooseExtension: true });
    await type('Dockerfile');
    await typeInto(extensionField(), '');

    expect(willBeCalled()).toBe('Dockerfile');

    button('create-only').click();
    await flushPromises();

    expect(created()).toEqual([
      [{ format: 'txt', name: 'Dockerfile', extension: '', open: false }],
    ]);
  });

  // Nothing is said about an extension a document already carries: a reader who
  // typed `report.sql` and left `sql` in the field wants `report.sql`.
  it('is not said twice when the name already ends in it', async () => {
    await mountDialog({ format: 'txt', chooseExtension: true });
    await type('report.SQL');
    await typeInto(extensionField(), 'sql');

    expect(willBeCalled()).toBe('report.SQL');
  });

  // The box is opened once per type from the drawer, so the field has to be
  // refilled each time rather than keeping what the last document asked for.
  it('goes back to the format each time the box opens', async () => {
    await mountDialog({ format: 'txt', chooseExtension: true });
    await typeInto(extensionField(), 'json');
    expect(extensionField().value).toBe('json');

    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true, format: 'md' });
    await flushPromises();

    expect(extensionField().value).toBe('md');
  });

  // Nothing carries one where there is nothing to carry it: the office formats
  // never send the field, so the server keeps the template's own extension.
  it('is left out of the request for a document made from a template', async () => {
    await mountDialog({ format: 'pptx', chooseExtension: false });

    button('create-and-open').click();
    await flushPromises();

    expect(created()).toEqual([[{ format: 'pptx', name: 'Document', open: true }]]);
  });
});
