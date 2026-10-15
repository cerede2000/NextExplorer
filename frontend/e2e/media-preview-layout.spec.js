import { expect, test } from '@playwright/test';

/**
 * A video has to fit inside the stage, because the stage clips.
 *
 * `max-h-full` on the video used to resolve against a wrapper whose own height
 * was content-driven, and a percentage against an indefinite height computes to
 * none. The video therefore took its natural height and hung below the stage,
 * which has `overflow: hidden` — so its control bar, drawn at the bottom of the
 * element, was simply off-screen. Fullscreen brought it back, which is what
 * made it read as a browser quirk rather than a layout fault.
 */

/**
 * Which shape escapes depends on the stage, not the video: a video overflows
 * whenever it is taller in proportion than the space it is given.
 *
 * In a 1280x720 window the stage is about 1264x667, so anything taller than
 * roughly 1:2 escapes — which an ordinary 16:9 film is, and that is the case
 * people actually hit. A phone's stage is about 396x786, so it takes a video
 * taller than 2:1; a 9:16 phone video fits there and would pass against the
 * defect. Each project is therefore given the shape that is meaningful for its
 * own viewport, measured rather than assumed.
 */
const shapeFor = (projectName) => (projectName.startsWith('mobile') ? 'xtall' : 'wide');

/** `p-2` on the stage: what the video fills is the stage minus its padding. */
const STAGE_PADDING = 8;

const boxes = async (page) => {
  const stage = await page.locator('[data-test="media-preview"]').boundingBox();
  const video = await page.locator('video').boundingBox();
  if (!stage || !video) throw new Error('The preview did not render');
  return { stage, video };
};

test.describe('a video in the preview', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.goto(`/e2e/media-preview-shape.html?shape=${shapeFor(testInfo.project.name)}`);
    await expect(page.locator('video')).toBeVisible();
  });

  test('is contained by the stage that clips it', async ({ page }) => {
    const { stage, video } = await boxes(page);

    // One pixel of tolerance for sub-pixel rounding, not for a control bar.
    expect(video.y + video.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  });

  test('starts below the top of the stage', async ({ page }) => {
    const { stage, video } = await boxes(page);

    expect(video.y).toBeGreaterThanOrEqual(stage.y - 1);
  });

  /**
   * The symptom as it was reported: the control bar was gone. It lives in the
   * bottom of the element, so what proves it is reachable is that the last
   * stretch of the element is on screen.
   */
  test('leaves its control bar on screen', async ({ page }) => {
    const CONTROL_BAR_HEIGHT = 40;
    const { stage, video } = await boxes(page);

    const controlBarTop = video.y + video.height - CONTROL_BAR_HEIGHT;
    expect(controlBarTop).toBeLessThan(stage.y + stage.height);
    expect(video.y + video.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  });

  /**
   * Contained, not squashed — but the element is no longer the picture's shape.
   *
   * It used to be: the video was sized by its poster and merely limited by the
   * stage, so the box and the picture were the same rectangle and a ratio read
   * off the box proved the picture was not squashed. That is what left a video
   * with no poster at 300x150 (nxzai#499). The box is the stage's now and the
   * fit is what keeps the picture's own shape inside it, so the fit is what is
   * asserted — and the box is asserted to be the stage's, which the ratio could
   * not say. On this desktop viewport the old assertion also happened to pass
   * against the stage's shape, the two being 1.78 apart by coincidence of the
   * window size, so it would not have caught this either.
   */
  test('fills the stage, and contains the picture rather than stretching it', async ({ page }) => {
    const { stage, video } = await boxes(page);

    expect(video.width).toBeCloseTo(stage.width - STAGE_PADDING * 2, 0);
    expect(video.height).toBeCloseTo(stage.height - STAGE_PADDING * 2, 0);
    await expect(page.locator('video')).toHaveCSS('object-fit', 'contain');
  });

  /**
   * The swipe overlay is positioned against the wrapper, so it has to stop
   * short of the controls — otherwise the video is contained and the controls
   * are still unusable.
   */
  test('does not have the swipe overlay covering its controls', async ({ page }) => {
    const overlay = await page.locator('[aria-hidden="true"]').first().boundingBox();
    const { video } = await boxes(page);
    if (!overlay) throw new Error('The swipe overlay is missing');

    expect(video.y + video.height - (overlay.y + overlay.height)).toBeGreaterThanOrEqual(40);
  });
});

/**
 * A video with no poster still fills the stage (nxzai#499).
 *
 * Reported from an iPad: a 1080p film rendered about 128 px tall instead of
 * filling the preview, and its controls did nothing when tapped. Both are one
 * fault. The element was sized by its intrinsic dimensions, which come from the
 * poster or from the video's metadata — and a file whose thumbnail has not been
 * generated has no poster, while a mobile browser does not load metadata until
 * the reader asks it to play. With neither, a video element is 300x150. The
 * controls are then drawn at the bottom of that small box, nowhere near where
 * the reader taps, which is why they appeared dead rather than missing.
 *
 * Every other case here hands the element a poster, so each of them proves the
 * stage contains a video that already had a size. This one gives it none.
 */
test.describe('a video with no poster', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/media-preview-shape.html?shape=none');
    await expect(page.locator('video')).toBeVisible();
  });

  test('fills the stage rather than falling back to its own small size', async ({ page }) => {
    const { stage, video } = await boxes(page);

    // 300x150 is what a video element is with nothing to size it by; any stage
    // here is far larger, so the failure is unmistakable rather than marginal.
    expect(video.height).toBeGreaterThan(stage.height * 0.8);
    expect(video.width).toBeGreaterThan(stage.width * 0.8);
  });

  test('leaves its control bar where the stage ends, so a tap reaches it', async ({ page }) => {
    const CONTROL_BAR_HEIGHT = 40;
    const { stage, video } = await boxes(page);

    // The bar is drawn inside the bottom of the element. A reader taps the
    // bottom of the preview, so that is where the bottom of the element has to be.
    expect(video.y + video.height).toBeGreaterThan(stage.y + stage.height - CONTROL_BAR_HEIGHT);
    expect(video.y + video.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  });

  test('contains the picture rather than stretching it', async ({ page }) => {
    // The element is the stage's shape now, so what keeps a film from being
    // squashed is the fit. Said plainly, because `contain` is also what a
    // browser gives a video on its own: this does not hold the sizing above —
    // it passes on the version that produced the fault — it holds against
    // somebody later asking for `cover`, which fills the stage by cropping the
    // film, and which is a one-word change away.
    await expect(page.locator('video')).toHaveCSS('object-fit', 'contain');
  });
});
