import { expect, test } from '@playwright/test';

/**
 * A long file has to scroll inside the editor.
 *
 * CodeMirror grows with its document unless it is told to fill its host: for a
 * 900-line file `.cm-editor` was 20,000 px tall, and since the page's own root
 * is `h-screen overflow-hidden` everything past the first screen was clipped
 * with nothing anywhere to scroll. The wheel moved nothing in any browser.
 *
 * It was reported as a Firefox fault (#10) because what the keyboard did
 * differed: moving the caret scrolls a hidden container by as much as each
 * engine chooses, so in one browser it crawled and in the other it jumped.
 * Chromium was no better off, which is why this runs in both.
 */

const scroller = '.cm-scroller';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/editor-scroll.html');
  await expect(page.locator('.cm-editor')).toBeVisible();
  // CodeMirror measures itself after a frame; nothing below is true before it.
  await page.waitForFunction(() => {
    const el = document.querySelector('.cm-scroller');
    return el && el.scrollHeight > 0;
  });
});

test('the editor is a viewport over the document, not the whole of it', async ({ page }) => {
  const sizes = await page.locator(scroller).evaluate((el) => ({
    visible: el.clientHeight,
    document: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));

  expect(sizes.overflowY).toBe('auto');
  // The editor fills the space it was given rather than the document's height.
  expect(sizes.visible).toBeLessThan(sizes.document / 4);
  expect(sizes.visible).toBeGreaterThan(100);
});

test('nothing hangs below the page, which cannot scroll', async ({ page }) => {
  // The page clips: anything that overflows it is unreachable, and that was
  // the defect rather than a symptom of it.
  const page_ = await page.locator('[data-test="page"]').evaluate((el) => ({
    visible: el.clientHeight,
    content: el.scrollHeight,
  }));

  expect(page_.content).toBeLessThanOrEqual(page_.visible + 2);
});

test('the wheel moves the document', async ({ page }) => {
  const box = await page.locator(scroller).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1200);

  await expect
    .poll(() => page.locator(scroller).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(50);
});

test('so does the keyboard, and it comes back', async ({ page }) => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');

  await expect
    .poll(() => page.locator(scroller).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(50);

  // Back up the same way. Not Ctrl+Home: the binding for the start of the
  // document is the platform's, and this test is about the viewport rather
  // than about CodeMirror's keymap.
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect.poll(() => page.locator(scroller).evaluate((el) => el.scrollTop)).toBe(0);
});
