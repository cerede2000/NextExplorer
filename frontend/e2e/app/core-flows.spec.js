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
  await page.getByRole('button', { name: 'Restore', exact: true }).click();

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

/**
 * A deleted folder is one item in the trash, and what is inside it can still
 * come back on its own — to its place inside the folder, while the rest stays.
 */
test('one file comes back out of a deleted folder, and the rest stays in the trash', async () => {
  const folder = path.join(volume, 'client');
  fs.mkdirSync(path.join(folder, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'brief.txt'), 'the brief\n');
  fs.writeFileSync(path.join(folder, 'drafts', 'v1.txt'), 'first draft\n');
  fs.writeFileSync(path.join(folder, 'drafts', 'v2.txt'), 'second draft\n');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select client' }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => fs.existsSync(folder)).toBe(false);
  await expect.poll(() => trashPayloads().length).toBe(1);
  const [payload] = trashPayloads();

  await page.goto('/trash');
  await page.getByRole('button', { name: 'Open client' }).click();
  await expect(page).toHaveURL(/\/trash\?item=/);
  await page.getByRole('button', { name: 'Open drafts' }).click();
  await page.getByRole('checkbox', { name: 'Select v2.txt' }).check();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();

  const restored = path.join(folder, 'drafts', 'v2.txt');
  await expect
    .poll(() => (fs.existsSync(restored) ? fs.readFileSync(restored, 'utf8') : null))
    .toBe('second draft\n');
  // Only that file left the trash: the rest of the folder is still in it, and
  // still listed there.
  expect(fs.readdirSync(folder)).toEqual(['drafts']);
  expect(fs.existsSync(path.join(trashDirectory, payload, 'drafts', 'v2.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(trashDirectory, payload, 'drafts', 'v1.txt'), 'utf8')).toBe(
    'first draft\n'
  );
  await expect(page.getByRole('checkbox', { name: 'Select v1.txt' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select v2.txt' })).toHaveCount(0);

  // The rest still comes back whole. Its name is taken now, by the folder the
  // file went back into, so it takes a suffix rather than replacing it.
  await page.getByRole('button', { name: 'Restore whole folder' }).click();
  await expect(page).toHaveURL(/\/trash$/);
  const rest = path.join(volume, 'client (1)');
  await expect.poll(() => fs.existsSync(path.join(rest, 'drafts', 'v1.txt'))).toBe(true);
  expect(fs.readFileSync(path.join(rest, 'brief.txt'), 'utf8')).toBe('the brief\n');
  expect(fs.readFileSync(restored, 'utf8')).toBe('second draft\n');
  expect(trashPayloads()).toEqual([]);
});

/**
 * Restoring into a folder chosen with the dialog a move uses: the file lands
 * in that folder, not where it was deleted from.
 */
test('a deleted file can be restored into another folder', async () => {
  const archive = path.join(volume, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const file = path.join(volume, 'invoice.txt');
  fs.writeFileSync(file, 'invoice 42\n');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select invoice.txt' }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => fs.existsSync(file)).toBe(false);
  await expect.poll(() => trashPayloads().length).toBe(1);

  await page.goto('/trash');
  await page.getByRole('checkbox', { name: 'Select invoice.txt' }).check();
  await page.getByRole('button', { name: 'Restore to…' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Restore to');
  await dialog.getByRole('option', { name: 'Projects' }).click();
  await dialog.getByRole('option', { name: 'archive' }).click();
  await dialog.getByRole('button', { name: 'Restore here' }).click();

  const landed = path.join(archive, 'invoice.txt');
  await expect
    .poll(() => (fs.existsSync(landed) ? fs.readFileSync(landed, 'utf8') : null))
    .toBe('invoice 42\n');
  expect(fs.existsSync(file)).toBe(false);
  expect(trashPayloads()).toEqual([]);
  await expect(page.getByText('The trash is empty.')).toBeVisible();
});

/**
 * A deleted script can be read before deciding: a right click, Preview, and the
 * editor shows it — read only, nothing to save — then Close is back in the trash.
 */
test('a deleted script is read in the editor from the right-click menu, and cannot be changed', async () => {
  const script = path.join(volume, 'deploy.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho deployed\n');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select deploy.sh' }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => fs.existsSync(script)).toBe(false);
  await expect.poll(() => trashPayloads().length).toBe(1);

  await page.goto('/trash');
  await page.locator('[data-trash-row]', { hasText: 'deploy.sh' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview' }).click();

  await expect(page).toHaveURL(/\/trash\/view\//);
  await expect(page.getByText('In the trash · read only')).toBeVisible();
  const content = page.locator('.cm-content');
  await expect(content).toContainText('echo deployed');
  await expect(content).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/trash$/);
  // Read, not restored: it is still in the trash, as it was.
  expect(trashPayloads()).toHaveLength(1);
  expect(fs.readFileSync(path.join(trashDirectory, trashPayloads()[0]), 'utf8')).toBe(
    '#!/bin/sh\necho deployed\n'
  );
});
