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

/** The intrinsic size of each fixture poster, which is what sizes the element. */
const POSTER_ASPECT = { wide: 1920 / 1080, xtall: 600 / 1600 };

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

  /** Contained, not squashed: the picture keeps the shape it was filmed in. */
  test('keeps its aspect ratio', async ({ page }, testInfo) => {
    const { video } = await boxes(page);
    const expected = POSTER_ASPECT[shapeFor(testInfo.project.name)];

    expect(video.width / video.height).toBeCloseTo(expected, 1);
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
