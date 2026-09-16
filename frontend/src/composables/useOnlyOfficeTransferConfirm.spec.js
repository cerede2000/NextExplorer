import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

import OnlyOfficeTransferConfirm from '@/components/OnlyOfficeTransferConfirm.vue';
import { useOnlyOfficeTransferConfirm } from '@/composables/useOnlyOfficeTransferConfirm';

/**
 * The question asked before moving or copying a document that is open in
 * ONLYOFFICE. The Document Server saves to the path it opened, so a transfer
 * in the middle of an edit can lose that save. The question must come up only
 * when a document is actually open (asking about every drop teaches people to
 * click through it), must name the documents, and the transfer must wait for
 * the answer: continuing proceeds, cancelling does not.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { close: 'Close' },
      onlyoffice: {
        andOthers: 'and {count} more',
        transferHeading: 'File is being edited',
        transferBody: 'This file is open in OnlyOffice.',
        transferConfirm: 'Continue',
        transferCancel: 'Cancel',
      },
    },
  },
});

const editing = (name) => ({ name, onlyofficeActivity: { active: true } });

const settled = (promise) => {
  const state = { done: false, value: undefined };
  promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
};

let wrapper = null;

const mountDialog = () => {
  wrapper = mount(OnlyOfficeTransferConfirm, {
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  return wrapper;
};

const button = (label) =>
  [...document.querySelectorAll('[role="dialog"] button')].find(
    (element) => element.textContent.trim() === label
  );

afterEach(async () => {
  // One question is shared by the whole app; leave none open for the next test.
  useOnlyOfficeTransferConfirm().cancel();
  wrapper?.unmount();
  wrapper = null;
  await flushPromises();
  document.body.innerHTML = '';
});

describe('the ONLYOFFICE transfer question', () => {
  it('lets a transfer go ahead without asking when none of its documents is open', async () => {
    const question = useOnlyOfficeTransferConfirm();

    await expect(
      question.requestConfirmation([
        { name: 'notes.txt' },
        { name: 'report.docx', onlyofficeActivity: { active: false } },
        { name: 'budget.xlsx', onlyofficeActivity: null },
        null,
      ])
    ).resolves.toBe(true);
    await expect(question.requestConfirmation(undefined)).resolves.toBe(true);

    expect(question.isOpen.value).toBe(false);
  });

  it('asks when a document is open, about that document only, and waits for the answer', async () => {
    const question = useOnlyOfficeTransferConfirm();

    const answer = settled(
      question.requestConfirmation([{ name: 'notes.txt' }, editing('report.docx')])
    );
    await flushPromises();

    expect(question.isOpen.value).toBe(true);
    expect(question.activeItems.value.map((item) => item.name)).toEqual(['report.docx']);
    expect(answer.done).toBe(false);
  });

  it('lets the transfer proceed when the person continues, and closes the question', async () => {
    const question = useOnlyOfficeTransferConfirm();
    const answer = question.requestConfirmation([editing('report.docx')]);

    question.confirm();

    await expect(answer).resolves.toBe(true);
    expect(question.isOpen.value).toBe(false);
    expect(question.activeItems.value).toEqual([]);
  });

  it('stops the transfer when the person cancels', async () => {
    const question = useOnlyOfficeTransferConfirm();
    const answer = question.requestConfirmation([editing('report.docx')]);

    question.cancel();

    await expect(answer).resolves.toBe(false);
    expect(question.isOpen.value).toBe(false);
  });

  it('takes only the first answer, and ignores one given when nothing was asked', async () => {
    const question = useOnlyOfficeTransferConfirm();
    const answer = question.requestConfirmation([editing('report.docx')]);

    question.confirm();
    question.cancel();
    await expect(answer).resolves.toBe(true);

    expect(() => question.confirm()).not.toThrow();
    expect(question.isOpen.value).toBe(false);
  });

  it('is one question shared by the dialog and every screen that asks it', () => {
    expect(useOnlyOfficeTransferConfirm()).toBe(useOnlyOfficeTransferConfirm());
  });
});

describe('the ONLYOFFICE transfer dialog', () => {
  it('names the first two documents open in the editor and says how many more there are', async () => {
    mountDialog();
    const question = useOnlyOfficeTransferConfirm();

    question.requestConfirmation([
      editing('report.docx'),
      { name: 'notes.txt' },
      editing('budget.xlsx'),
      editing('slides.pptx'),
      editing('plan.docx'),
    ]);
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('File is being edited');
    expect(dialog.textContent).toContain('report.docx, budget.xlsx and 2 more');
    expect(dialog.textContent).not.toContain('notes.txt');
    expect(dialog.textContent).not.toContain('slides.pptx');
  });

  it('names both documents and nothing more when there are only two', async () => {
    mountDialog();

    useOnlyOfficeTransferConfirm().requestConfirmation([
      editing('report.docx'),
      editing('budget.xlsx'),
    ]);
    await flushPromises();

    const text = document.querySelector('[role="dialog"]').textContent;
    expect(text).toContain('report.docx, budget.xlsx');
    expect(text).not.toContain('more');
  });

  it('does not show a dialog when nothing is asked', async () => {
    mountDialog();

    await useOnlyOfficeTransferConfirm().requestConfirmation([{ name: 'notes.txt' }]);
    await flushPromises();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('proceeds when Continue is clicked', async () => {
    mountDialog();
    const answer = useOnlyOfficeTransferConfirm().requestConfirmation([editing('report.docx')]);
    await flushPromises();

    button('Continue').click();

    await expect(answer).resolves.toBe(true);
  });

  it('does not proceed when Cancel is clicked', async () => {
    mountDialog();
    const answer = useOnlyOfficeTransferConfirm().requestConfirmation([editing('report.docx')]);
    await flushPromises();

    button('Cancel').click();

    await expect(answer).resolves.toBe(false);
  });

  it('treats closing the dialog without answering as cancelling', async () => {
    mountDialog();
    const answer = useOnlyOfficeTransferConfirm().requestConfirmation([editing('report.docx')]);
    await flushPromises();

    document
      .querySelector('[role="dialog"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await expect(answer).resolves.toBe(false);
  });
});

/**
 * Two transfers asking at once.
 *
 * One question is shared by the whole application, so a second one replaces
 * the first. The first was simply dropped: its promise never settled, and
 * whoever was waiting on it — a move, a copy — waited for the rest of the
 * tab's life. The dialog is modal, so reaching this takes a transfer started
 * from somewhere that does not go through it; the cost of being wrong about
 * that is an operation that never finishes and never says so.
 */
describe('a second question while the first is open', () => {
  it('answers the first rather than abandoning it', async () => {
    const question = useOnlyOfficeTransferConfirm();
    mountDialog();

    const first = settled(question.requestConfirmation([editing('report.docx')]));
    const second = settled(question.requestConfirmation([editing('budget.xlsx')]));
    await flushPromises();

    expect(first.done).toBe(true);
    expect(first.value).toBe(false);
    expect(second.done).toBe(false);

    question.confirm();
    await flushPromises();

    expect(second.value).toBe(true);
  });

  it('shows the documents of the question that replaced it', async () => {
    const question = useOnlyOfficeTransferConfirm();
    mountDialog();

    question.requestConfirmation([editing('report.docx')]);
    question.requestConfirmation([editing('budget.xlsx')]);
    await flushPromises();

    expect(question.isOpen.value).toBe(true);
    expect(question.activeItems.value.map((item) => item.name)).toEqual(['budget.xlsx']);
  });
});
