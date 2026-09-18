import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { findUnreachableContent } from './unreachable.js';

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
/**
 * What the trash holds on disk: the items, not their descriptions.
 *
 * Read through a poll wherever it should be empty: content leaves the trash by
 * being linked under its new name and then unlinked from the old one, so at the
 * instant the restored file is readable its payload can still be there. Read
 * once, the assertion is a race — and it lost one on CI.
 */
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
  await expect.poll(() => trashPayloads()).toEqual([]);
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
  await expect.poll(() => trashPayloads()).toEqual([]);
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
  await expect.poll(() => trashPayloads()).toEqual([]);
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

/**
 * A shared file sent to the trash: its link stops working at once, the delete
 * dialog having said so; restored with "Restore the share links", the very same
 * link works again for someone with no account.
 */
test('a shared file sent to the trash comes back with its link', async ({ browser }) => {
  const file = path.join(volume, 'plan.txt');
  fs.writeFileSync(file, 'the plan\n');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select plan.txt' }).click();
  await page.getByRole('button', { name: 'Share selected item' }).click();
  const shareDialog = page.getByRole('dialog');
  await shareDialog.getByRole('button', { name: 'Create Share Link' }).click();
  const linkField = shareDialog.locator('input[readonly]').first();
  await expect(linkField).toHaveValue(/\/share\/[A-Za-z0-9_-]+$/);
  const shareUrl = (await linkField.inputValue()).replace('/share/', '/api/share/');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select plan.txt' }).click();
  await page.keyboard.press('Delete');
  const deleteDialog = page.getByRole('dialog');
  await expect(deleteDialog).toContainText('stops working while the content is in the trash');
  await deleteDialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => fs.existsSync(file)).toBe(false);

  const stranger = await browser.newContext({ locale: 'en-US' });
  try {
    expect((await stranger.request.get(shareUrl)).status()).toBe(404);

    await page.goto('/trash');
    await expect(page.locator('[data-trash-row]', { hasText: 'plan.txt' })).toContainText('Shared');
    await page.getByRole('checkbox', { name: 'Select plan.txt' }).check();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    const question = page.getByRole('dialog');
    await expect(question).toContainText('What about the share links?');
    await question.getByRole('button', { name: 'Restore the share links' }).click();
    await expect.poll(() => fs.existsSync(file)).toBe(true);

    const back = await stranger.request.get(shareUrl);
    expect(back.status()).toBe(200);
    expect(await back.text()).toBe('the plan\n');
  } finally {
    await stranger.close();
  }
});

/**
 * A file longer than the window has to be reachable in the editor.
 *
 * Reported as #10, against Firefox, and it was broken in every browser:
 * CodeMirror grows with its document unless it is told to fill its host, and
 * the page's own root clips. So a 900-line file drew 20,000 px of editor with
 * no viewport anywhere to scroll, and the wheel moved nothing.
 *
 * The component's side of this is covered in two engines by
 * `e2e/editor-scroll.spec.js`. What only the real view can show is the other
 * half: that the chain of heights from the page down to the editor is
 * unbroken, which is one `min-h-0` away from being false again.
 */
test('a file longer than the window scrolls inside the editor', async () => {
  const file = path.join(volume, 'long-notes.md');
  fs.writeFileSync(
    file,
    Array.from({ length: 900 }, (_, index) => `line ${index + 1} of a long file`).join('\n')
  );

  await page.goto('/editor/Projects/long-notes.md');
  const scroller = page.locator('.cm-scroller');
  await expect(page.locator('.cm-content')).toContainText('line 1 of a long file');

  const sizes = await scroller.evaluate((el) => ({
    visible: el.clientHeight,
    document: el.scrollHeight,
  }));
  // A viewport over the document rather than the whole of it.
  expect(sizes.visible).toBeLessThan(sizes.document / 4);

  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);

  // And the page itself still clips nothing: whatever the editor does not
  // show is inside it, not hanging off the bottom of the window.
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('#app > div');
    return root.scrollHeight - root.clientHeight;
  });
  expect(overflow).toBeLessThanOrEqual(2);
});

/**
 * Every save in the editor keeps what it replaced. From a right click, the
 * Versions panel lists those versions and puts an earlier one back — and what
 * the restore replaced is kept in turn, so restoring the wrong one loses
 * nothing. The content is checked on the disk, not only on screen.
 */
test('an earlier version of a file edited in the browser comes back from the Versions panel', async () => {
  const file = path.join(volume, 'minutes.txt');
  fs.writeFileSync(file, 'draft one');

  const saveInEditor = async (text) => {
    await page.goto('/editor/Projects/minutes.txt');
    const content = page.locator('.cm-content');
    await expect(content).toContainText('draft');
    await content.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(text);
  };

  await saveInEditor('draft two');
  await saveInEditor('draft three');

  await page.goto('/browse/Projects');
  await page.getByRole('button', { name: 'Select minutes.txt' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Versions', exact: true }).click();

  const panel = page.getByRole('dialog', { name: 'File versions' });
  await expect(panel).toContainText('minutes.txt');
  const rows = panel.locator('[data-test="version-row"]');
  await expect(rows).toHaveCount(2);

  // Newest first: the last one is the file as it was before the first save.
  await rows.last().getByRole('button', { name: 'Version actions' }).click();
  // Exactly: "Restore as a copy…" is in the same menu.
  await panel.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  // Asked first.
  expect(fs.readFileSync(file, 'utf8')).toBe('draft three');
  await page.locator('[data-test="versions-confirm"]').click();

  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('draft one');
  await expect(page.getByText('Version restored')).toBeVisible();
  // What the restore replaced is a version now, beside the two there were.
  await expect(rows).toHaveCount(3);
});

/**
 * No screen may hide content where nothing can scroll.
 *
 * This is the last test on purpose: it fills the installation with more than
 * fits — thirty volumes, three hundred files, a nine-hundred-line file — and
 * then looks at every screen for the shape of the defect reported as #10
 * rather than for the defect itself. That shape is content taller than its box
 * with nothing scrollable between it and the first ancestor that clips, and
 * looking for it found three more the day #10 was fixed: the search results
 * showed ten of a hundred matches, the dashboard clipped its last volumes, and
 * the sidebar could only be scrolled by a pointer that hovered it.
 *
 * A screen that does not load proves nothing, so each one names something that
 * has to be on it before it is judged.
 */
test('no screen hides content where nothing can scroll', async () => {
  const volumes = path.join(process.env.E2E_ROOT, 'volumes');
  for (let index = 1; index <= 30; index += 1) {
    const extra = path.join(volumes, `Volume-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'one.txt'), 'x');
  }
  for (let index = 1; index <= 300; index += 1) {
    fs.writeFileSync(path.join(volume, `many-${String(index).padStart(3, '0')}.txt`), 'x');
  }
  fs.writeFileSync(
    path.join(volume, 'wall-of-text.md'),
    Array.from({ length: 900 }, (_, line) => `line ${line + 1}`).join('\n')
  );

  // Markers that do not depend on which rows happen to be drawn: the folder
  // listing renders only what is in view and in whatever order it was last
  // sorted, so naming one file is a coin toss — any of the three hundred
  // proves the screen is there.
  const screens = [
    ['the dashboard, with thirty volumes', '/browse/', 'text=Volume-30'],
    ['a folder of three hundred files', '/browse/Projects', 'text=/many-\\d{3}\\.txt/'],
    ['the editor on a long file', '/editor/Projects/wall-of-text.md', '.cm-content'],
    ['the search results', '/search?q=many', 'text=/many-\\d{3}\\.txt/'],
    ['the accounts in the settings', '/settings/admin-users', 'text=admin@example.com'],
    ['the activity log in the settings', '/settings/activity', 'text=Activity log'],
    ['the API tokens in the settings', '/settings/account-api-tokens', 'text=New token'],
    ['the trash', '/trash', 'body'],
  ];

  for (const [what, route, marker] of screens) {
    await page.goto(route);
    // Loaded afresh rather than navigated to: the stores this page already
    // holds were filled before the volumes above existed.
    await page.reload();
    // Nothing is judged before the screen is actually there.
    await expect(page.locator(marker).first()).toBeVisible({ timeout: 15000 });
    // The pointer parked away from everything: a panel that scrolls only
    // under a hovering pointer is one a touch screen cannot scroll at all.
    await page.mouse.move(2, 2);

    const found = await page.evaluate(findUnreachableContent);
    expect(found, `${what} (${route}) hides content: ${JSON.stringify(found, null, 2)}`).toEqual(
      []
    );
  }
});

/**
 * The same question for what opens on top of a screen.
 *
 * A panel or a dialog is a box with a height of its own, which is exactly
 * where content with nowhere to go hides: the list inside it is short in the
 * seeded state of most tests and long in somebody's real installation. Each
 * one is filled with more than fits before it is looked at.
 */
test('no panel or dialog hides content where nothing can scroll', async () => {
  // Whichever row the listing drew, rather than one named in advance: it
  // renders what is in view, in the order it was last sorted.
  const aRow = () => page.getByRole('button', { name: /^Select many-/ }).first();
  const rightClick = async () => {
    await page.goto('/browse/Projects');
    await expect(aRow()).toBeVisible();
    await aRow().click({ button: 'right' });
  };

  const surfaces = [
    [
      'the info panel',
      async () => {
        await rightClick();
        // The entries of this menu are buttons, as the tests above use them.
        await page.getByRole('button', { name: 'Get Info' }).click();
      },
      '[aria-label="Info panel"]',
    ],
    [
      'the share dialog',
      async () => {
        await page.goto('/browse/Projects');
        await expect(aRow()).toBeVisible();
        await aRow().click();
        await page.getByRole('button', { name: 'Share selected item' }).click();
      },
      'role=dialog',
    ],
    [
      'the notifications panel',
      async () => {
        await page.goto('/browse/Projects');
        await page.getByRole('button', { name: 'Open notifications' }).click();
      },
      // The close button carries its label in a screen-reader span rather
      // than an attribute, so the heading is what says the panel is open.
      'role=heading[name="Notifications"]',
    ],
  ];

  for (const [what, open, marker] of surfaces) {
    await open();
    await expect(page.locator(marker).first()).toBeVisible({ timeout: 10000 });
    await page.mouse.move(2, 2);

    const found = await page.evaluate(findUnreachableContent);
    expect(found, `${what} hides content: ${JSON.stringify(found, null, 2)}`).toEqual([]);
    await page.keyboard.press('Escape');
  }
});

/**
 * And on a phone, where every box is shorter and the same content has further
 * to go. The viewport is put back afterwards whatever happens: the tests in
 * this file share one page, in order.
 */
test('nothing is hidden on a phone either', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const screens = [
      ['the dashboard', '/browse/', 'text=Volume-30'],
      ['a folder of three hundred files', '/browse/Projects', 'text=/many-\\d{3}\\.txt/'],
      ['the editor on a long file', '/editor/Projects/wall-of-text.md', '.cm-content'],
      ['the search results', '/search?q=many', 'text=/many-\\d{3}\\.txt/'],
      ['the accounts in the settings', '/settings/admin-users', 'text=admin@example.com'],
      ['the API tokens in the settings', '/settings/account-api-tokens', 'text=New token'],
    ];
    for (const [what, route, marker] of screens) {
      await page.goto(route);
      await page.reload();
      await expect(page.locator(marker).first()).toBeVisible({ timeout: 15000 });
      await page.mouse.move(2, 2);

      const found = await page.evaluate(findUnreachableContent);
      expect(
        found,
        `${what} (${route}) hides content on a phone: ${JSON.stringify(found, null, 2)}`
      ).toEqual([]);
    }
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});
