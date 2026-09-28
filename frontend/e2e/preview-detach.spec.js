import { expect, test } from '@playwright/test';

/**
 * A viewer that takes its own element out of the page, in a real browser.
 *
 * ONLYOFFICE replaces the element it is handed with an `iframe`, so the node Vue
 * believes it owns is no longer in the document. What follows happens inside
 * Vue's patch: updating a component means patching into the parent of what it
 * rendered last time, and that parent is null — so anything mounted during that
 * patch throws, the render stops half done, and every render after it fails on
 * elements that are suddenly missing.
 *
 * None of it can be seen in a unit test. jsdom reports no transition support, so
 * a leave a real browser spreads over two hundred milliseconds happens there at
 * once, and the document being shut is never still in the page while the next one
 * is being built. Switching tabs is a gesture people make far faster than that,
 * which is why tabs are where this started to hurt.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/preview-detach.html');
  await expect.poll(() => page.evaluate(() => typeof window.openDocument)).toBe('function');
});

const thrown = (page) => page.evaluate(() => window.thrown);
const frames = (page) => page.evaluate(() => window.frames_());
/** Which documents are on screen, in the order of the tabs holding them. */
const documents = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('iframe[data-document]')].map((node) => node.dataset.document)
  );

test('one document opens and its element goes, without breaking the page', async ({ page }) => {
  await page.evaluate(() => window.openDocument(0, 'report.docx'));

  await expect.poll(() => frames(page)).toBe(1);
  expect(await thrown(page)).toEqual([]);
});

test('two of them, one per tab', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });

  await expect.poll(() => frames(page)).toBe(2);
  expect(await thrown(page)).toEqual([]);
});

test('a tab comes forward, and goes back', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => window.activateTab(1));
  await page.evaluate(() => window.activateTab(0));

  // Nothing was rebuilt to bring one forward: the same two frames are still here.
  await expect.poll(() => frames(page)).toBe(2);
  expect(await thrown(page)).toEqual([]);
});

/**
 * The one that matters: shut and opened again faster than anything can fade.
 * With a fade over the shutting document, the page held two of them at once —
 * one being taken away, one being built — and the patch lost its place.
 */
test('shutting one and opening the next immediately', async ({ page }) => {
  for (const name of ['one.docx', 'two.docx', 'three.docx', 'four.docx']) {
    await page.evaluate((file) => {
      window.closeDocument(0);
      window.openDocument(0, file);
    }, name);
  }

  await expect.poll(() => frames(page)).toBe(1);
  expect(await thrown(page)).toEqual([]);
});

test('switching tabs while one of them is being shut', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => {
    window.closeDocument(1);
    window.activateTab(1);
    window.openDocument(1, 'another.docx');
    window.activateTab(0);
  });

  await expect.poll(() => frames(page)).toBe(2);
  expect(await thrown(page)).toEqual([]);
});

/**
 * A second document opened over one whose editor is alive.
 *
 * The one the crash came from, and it needs no tabs at all. The editor is told to
 * rebuild for the new file, so it takes itself off screen — and the element Vue
 * has to work around is the one the Document Server's script replaced with an
 * `iframe`. Asking that element for its parent, to know where to leave the mark
 * of what was removed, answers null.
 */
test('a second document opened over a live editor', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => window.openDocument(1, 'another.docx'));

  await expect.poll(() => documents(page)).toEqual(['Docs/report.docx', 'Docs/another.docx']);
  expect(await thrown(page)).toEqual([]);
});

/** And the same thing with one tab, because this was never about tabs. */
test('a second document opened over a live editor, in one tab', async ({ page }) => {
  await page.evaluate(() => window.openDocument(0, 'report.docx'));
  await expect.poll(() => frames(page)).toBe(1);

  await page.evaluate(() => window.openDocument(0, 'another.docx'));

  await expect.poll(() => documents(page)).toEqual(['Docs/another.docx']);
  expect(await thrown(page)).toEqual([]);
});

/**
 * A tab closed while the document in it is alive.
 *
 * The surfaces are a keyed list inside one teleport, so closing a tab takes a
 * whole subtree out of the middle of it — and that subtree holds an element the
 * page no longer has. Everything after it in the list is then moved around what
 * was removed.
 */
test('a tab closed while its editor is alive', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => window.closeTab(0));

  await expect.poll(() => frames(page)).toBe(1);
  expect(await thrown(page)).toEqual([]);
});

/** And the same list, with the tabs put in another order underneath them. */
test('a tab moved while its editor is alive', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => {
    window.moveTab(0, 1);
    window.moveTab(1, 0);
    window.moveTab(0, 1);
  });

  await expect.poll(() => frames(page)).toBe(2);
  expect(await thrown(page)).toEqual([]);
});

/** A third tab arriving between two live editors. */
test('a tab opened between two live editors', async ({ page }) => {
  await page.evaluate(() => {
    window.openDocument(0, 'report.docx');
    window.openDocument(1, 'budget.docx');
  });
  await expect.poll(() => frames(page)).toBe(2);

  await page.evaluate(() => {
    const made = window.newTab();
    window.moveTab(made, 1);
    window.openDocument(made, 'third.docx');
  });

  await expect.poll(() => frames(page)).toBe(3);
  expect(await thrown(page)).toEqual([]);
});
