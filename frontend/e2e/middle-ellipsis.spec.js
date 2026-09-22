import { expect, test } from '@playwright/test';

/**
 * A name in the listing is drawn in two halves, so its end stays readable when
 * the row is too narrow. The split happens whatever the width, and when there
 * is room the halves have to read as one uninterrupted name.
 *
 * They did not. Both halves were `whitespace-nowrap`, and a flex item drops the
 * white space at the edges of its line, so a split landing on a space ate it:
 * the folder "02. Test messagerie" was drawn "02. Testmessagerie", while the
 * rename box — one plain input — still showed the real name. Only the space on
 * the cut went; every other one survived, which is what made it look arbitrary.
 *
 * Nothing in jsdom can see this: the space is in the DOM either way, and it is
 * the layout that drops it. So this is measured in a browser, on the real
 * stylesheet, by comparing what is drawn against the name it should draw.
 */

/** The width the two halves really take, and the width the name should take. */
const widths = async (page) => {
  const halves = await page.locator('#subject > span > span').all();
  const drawn = await Promise.all(halves.map(async (half) => (await half.boundingBox()).width));
  const reference = (await page.locator('#reference').boundingBox()).width;
  return { drawn: drawn.reduce((total, width) => total + width, 0), reference };
};

const show = (page, name, endChars = 10) =>
  page.goto(`/e2e/middle-ellipsis.html?name=${encodeURIComponent(name)}&endChars=${endChars}`);

test.describe('a name split for the ellipsis', () => {
  /**
   * "02. Test messagerie" cut ten from the end is "02. Test " + "messagerie":
   * the space ends the first half. This is the case from the report.
   */
  test('keeps a space that ends the first half', async ({ page }) => {
    await show(page, '02. Test messagerie');

    const { drawn, reference } = await widths(page);

    expect(drawn).toBeCloseTo(reference, 0);
  });

  /**
   * The other edge: "rapport final.pdf" cut ten from the end is "rapport" +
   * " final.pdf", so the space opens the second half and is dropped there.
   */
  test('keeps a space that opens the second half', async ({ page }) => {
    await show(page, 'rapport final.pdf');

    const { drawn, reference } = await widths(page);

    expect(drawn).toBeCloseTo(reference, 0);
  });

  /** Runs of spaces are a name's own; the display is not the place to tidy them. */
  test('keeps a run of spaces inside the name', async ({ page }) => {
    await show(page, 'deux  espaces ici.txt');

    const { drawn, reference } = await widths(page);

    expect(drawn).toBeCloseTo(reference, 0);
  });

  /**
   * Keeping spaces means `white-space: pre`, which also honours a line break —
   * and a name may hold one. A row in a listing is one line tall, so a break is
   * drawn as a space rather than made into a second line.
   */
  test('draws a name holding a line break on one line', async ({ page }) => {
    await show(page, 'une ligne\nseule messagerie');
    const broken = (await page.locator('#subject').boundingBox()).height;

    await show(page, 'une ligne seule messagerie');
    const straight = (await page.locator('#subject').boundingBox()).height;

    expect(broken).toBeCloseTo(straight, 0);
  });
});
