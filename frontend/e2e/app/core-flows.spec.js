/* eslint-env node */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The journey one person takes through a fresh install, in order: set it up,
 * sign out and back in, open a volume, upload a file, share one with someone
 * who has no account. Each step depends on the one before it, as it would for
 * that person, so the steps share a page and run in sequence.
 *
 * The unit suites cover each of these in pieces. What they cannot cover is the
 * pieces together in a browser, against the server the image runs — which is
 * where a working API and a working component can still add up to a screen
 * that does nothing.
 */
test.describe.configure({ mode: 'serial' });

const admin = {
  email: 'admin@example.com',
  username: 'admin',
  password: 'correct-horse-battery',
};
const volume = path.join(process.env.E2E_ROOT, 'volumes', 'Projects');

let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test('the first visit sets up an administrator and signs them in', async () => {
  await page.goto('/');

  await page.locator('#setup-email').fill(admin.email);
  await page.locator('#setup-password').fill(admin.password);
  await page.locator('#setup-password-confirm').fill(admin.password);
  await page.locator('button[type="submit"]').click();

  // Signed in straight away, on the list of volumes.
  await expect(page).toHaveTitle('Volumes');
  await expect(page.getByText(admin.email)).toBeVisible();
});

/** Press `key` until `target` has focus, as someone without a mouse would. */
const pressUntilFocused = async (key, target, limit = 50) => {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press(key);
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`${key} never reached ${target}`);
};

test('signing out returns to the sign-in screen, and the username signs back in', async () => {
  // By keyboard alone. The account menu is the only way to Sign out, and its
  // toggle was once a div: clickable, but out of reach of every key. The exact
  // name is what a screen reader reads and what voice control answers to — the
  // word for the control, then the name and address shown on it.
  const account = page.getByRole('button', {
    name: `Account ${admin.username} ${admin.email}`,
    exact: true,
  });
  await pressUntilFocused('Tab', account);
  await page.keyboard.press('Enter');
  await expect(account).toHaveAttribute('aria-expanded', 'true');

  // The menu opens above its toggle, so its entries come before it.
  await pressUntilFocused('Shift+Tab', page.getByRole('button', { name: 'Sign out' }));
  await page.keyboard.press('Enter');

  await expect(page.locator('#login-identifier')).toBeVisible();

  // The username, not the email address: the account was created with only an
  // address, and the username it was given from it is enough to sign in.
  await page.locator('#login-identifier').fill(admin.username);
  await page.locator('#login-password').fill(admin.password);
  await page.locator('button[type="submit"]').click();

  await expect(page).toHaveTitle('Volumes');
});

test('a volume opens by its address and lists what is in it', async () => {
  // Opened by URL rather than by clicking: the address is served by the
  // single-page fallback, which only exists when the server has a build to
  // serve — exactly the route the unit suites never register.
  await page.goto('/browse/Projects');

  await expect(page.getByRole('button', { name: 'Select notes.txt' })).toBeVisible();
});

test('an uploaded file reaches the disk and the listing', async () => {
  const content = 'uploaded through the browser\n';

  await page.getByRole('button', { name: 'New' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Upload File' }).click(),
  ]);
  await chooser.setFiles({
    name: 'report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(content),
  });

  await expect(page.getByRole('button', { name: 'Select report.txt' })).toBeVisible({
    timeout: 15_000,
  });
  // The listing could be showing what the client expects rather than what
  // happened; the disk cannot.
  await expect
    .poll(() => {
      const file = path.join(volume, 'report.txt');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    })
    .toBe(content);
});

test('a shared link opens for someone with no account, and opens nothing else', async ({
  browser,
}) => {
  await page.getByRole('button', { name: 'Select notes.txt' }).click();
  await page.getByRole('button', { name: 'Share selected item' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create Share Link' }).click();

  const linkField = dialog.locator('input[readonly]').first();
  await expect(linkField).toHaveValue(/\/share\/[A-Za-z0-9_-]+$/);
  const link = await linkField.inputValue();

  // A separate browser context has none of the administrator's cookies: this
  // is a stranger who was sent the link.
  const stranger = await browser.newContext({ locale: 'en-US' });
  try {
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(link);
    await expect(strangerPage.getByRole('button', { name: 'Select notes.txt' })).toBeVisible();

    // The file itself, through the address the dialog hands out for it.
    const response = await stranger.request.get(link.replace('/share/', '/api/share/'));
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('hello from the e2e volume\n');

    // And the link is the only way in: the volume it came from is still shut.
    await strangerPage.goto('/browse/Projects');
    await expect(strangerPage.locator('#login-identifier')).toBeVisible();
  } finally {
    await stranger.close();
  }
});

const trashDirectory = path.join(volume, '.nextexplorer', 'trash');
/** What the trash holds on disk: the items, not their descriptions. */
const trashPayloads = () =>
  fs.existsSync(trashDirectory)
    ? fs.readdirSync(trashDirectory).filter((name) => !name.endsWith('.json'))
    : [];

/**
 * Deleting is a rename into the volume's own reserved space: the file leaves
 * the folder, its bytes wait on the same disk, and restoring puts back exactly
 * what was there. Checked on the disk, not only in the listing.
 */
test('a deleted file goes to the trash and comes back as it was', async () => {
  const content = 'uploaded through the browser\n';
  const file = path.join(volume, 'report.txt');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select report.txt' }).click();
  await page.keyboard.press('Delete');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('will go to the trash');
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();

  await expect.poll(() => fs.existsSync(file)).toBe(false);
  await expect.poll(() => trashPayloads().length).toBe(1);
  expect(fs.readFileSync(path.join(trashDirectory, trashPayloads()[0]), 'utf8')).toBe(content);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await page.getByRole('checkbox', { name: 'Select report.txt' }).check();
  await page.getByRole('button', { name: 'Restore' }).click();

  await expect
    .poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null))
    .toBe(content);
  expect(trashPayloads()).toEqual([]);
  await expect(page.getByText('The trash is empty.')).toBeVisible();
});

test('deleting for good from the trash takes the bytes off the disk', async () => {
  const file = path.join(volume, 'notes.txt');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select notes.txt' }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => fs.existsSync(file)).toBe(false);
  await expect.poll(() => trashPayloads().length).toBe(1);

  await page.goto('/trash');
  await page.getByRole('checkbox', { name: 'Select notes.txt' }).check();
  await page.getByRole('button', { name: 'Delete permanently' }).click();

  // Asked first: nothing leaves the trash on one click.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('removed for good');
  expect(trashPayloads()).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();

  await expect.poll(() => fs.readdirSync(trashDirectory)).toEqual([]);
  expect(fs.existsSync(file)).toBe(false);
});
