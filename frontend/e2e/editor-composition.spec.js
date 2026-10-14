import { expect, test } from '@playwright/test';

/**
 * The editor holds exactly what a virtual keyboard composed, and nothing else.
 *
 * A phone or a tablet does not type with key events. Its keyboard runs a
 * composition: a provisional string, revised as the software guesses at the
 * word, committed when it is sure. The browser reports that through
 * `compositionstart`, `beforeinput` with `insertCompositionText` and
 * `compositionend`, and CodeMirror reads its own DOM back to work out what
 * happened. Every other test in this repository types with key events, so that
 * whole path — the one every touch user is on — was never exercised.
 *
 * It is exercised here because the fault it hides is invisible everywhere else.
 * `@codemirror/view` rewrote its DOM update machinery and spent four releases
 * correcting it: 6.43.3 "could corrupt the editor state", 6.43.4 "could corrupt
 * the tile tree", 6.43.6 "another tile tree corruption bug", and 6.43.12 a bug
 * "in updating the DOM for marks around an active composition that could
 * sometimes try to use the same DOM node twice". A version in the middle of
 * that run reached this repository inside a commit about build-tooling
 * advisories, where nobody read it as a change to the editor — and no suite on
 * either side of the fork could have seen it. So this guards the boundary
 * rather than our own code: it is the tripwire that makes a dependency's
 * rewrite announce itself here instead of on somebody's tablet.
 *
 * Driven through Chromium's own IME, not through synthetic events: anything
 * dispatched by hand would prove only that CodeMirror handles what the test
 * sends it. `Input.imeSetComposition` is what the browser does when a keyboard
 * revises a word, and `Input.insertText` is what it does when it commits.
 */

const DOCUMENT_LINE = (index) => `line ${index} — plain text, nothing composed yet`;

const ready = async (page) => {
  await page.goto('/e2e/editor-composition.html');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await page.waitForFunction(() => window.__editorReady === true);
  // CodeMirror measures itself after a frame; a caret placed before that is
  // placed in an editor that does not yet know where its lines are.
  await page.waitForFunction(() => {
    const el = document.querySelector('.cm-scroller');
    return el && el.scrollHeight > 0;
  });
};

/** The document CodeMirror holds — the only thing that says what went wrong. */
const held = (page) => page.evaluate(() => window.__editorView.state.doc.toString());

/** What the content element saw, so a test that drove nothing cannot pass. */
const composed = (page) => page.evaluate(() => ({ ...window.__compositions }));

/** Put the caret somewhere, or select a range, through the editor's own API. */
const select = (page, anchor, head = anchor) =>
  page.evaluate(
    ([from, to]) => {
      const view = window.__editorView;
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    },
    [anchor, head]
  );

/**
 * One word, composed the way a keyboard composes it and then committed.
 *
 * The stages are the guesses: a keyboard sends the word as it stands after
 * every letter, each one replacing the last, and only the commit is text the
 * document keeps.
 */
const compose = async (client, word) => {
  for (let length = 1; length <= word.length; length += 1) {
    const text = word.slice(0, length);
    await client.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }
  await client.send('Input.insertText', { text: word });
};

test('a word composed and committed is the only thing the document gains', async ({ page }) => {
  await ready(page);
  const client = await page.context().newCDPSession(page);
  const before = await held(page);

  // The end of the first line, which is where somebody editing a file types.
  await select(page, DOCUMENT_LINE(1).length);
  await compose(client, 'bonjour');

  const after = await held(page);
  const events = await composed(page);
  // The path ran: without this the case would pass on an editor that ignored
  // every one of those messages.
  expect(events.started).toBeGreaterThan(0);
  expect(events.ended).toBeGreaterThan(0);
  // And the document gained the word, in that one place, and nothing else.
  expect(after).toBe(before.replace(DOCUMENT_LINE(1), `${DOCUMENT_LINE(1)}bonjour`));
});

test('a word composed over a selection replaces it, and nothing else', async ({ page }) => {
  await ready(page);
  const client = await page.context().newCDPSession(page);
  const before = await held(page);

  // "plain" on the first line, selected as a double tap selects a word.
  const at = DOCUMENT_LINE(1).indexOf('plain');
  await select(page, at, at + 'plain'.length);
  await compose(client, 'composed');

  const after = await held(page);
  expect((await composed(page)).ended).toBeGreaterThan(0);
  expect(after).toBe(before.replace('plain text', 'composed text'));
});

test('a burst of compositions with no pause leaves exactly what was composed', async ({ page }) => {
  await ready(page);
  const client = await page.context().newCDPSession(page);
  const before = await held(page);

  await select(page, DOCUMENT_LINE(1).length);
  const words = ['un', 'deux', 'trois', 'quatre', 'cinq'];
  for (const word of words) await compose(client, word);

  const after = await held(page);
  const events = await composed(page);
  expect(events.started).toBeGreaterThanOrEqual(words.length);
  expect(after).toBe(before.replace(DOCUMENT_LINE(1), `${DOCUMENT_LINE(1)}${words.join('')}`));
});

test('composing where every commit scrolls the view leaves exactly what was composed', async ({
  page,
}) => {
  await ready(page);
  const client = await page.context().newCDPSession(page);
  const before = await held(page);

  // The end of the document: the caret sits on the last line, so each commit
  // moves the view and CodeMirror remeasures its content in the middle of a
  // composition — which is the situation its DOM update code got wrong.
  await select(page, before.length);
  for (const word of ['alpha', 'beta', 'gamma']) await compose(client, word);

  const after = await held(page);
  expect((await composed(page)).ended).toBeGreaterThanOrEqual(3);
  expect(after).toBe(`${before}alphabetagamma`);
});

/**
 * The second half of this file: a document handed to the editor from outside
 * while somebody is composing.
 *
 * The editor is given its document as a value, and a new value replaces what is
 * on screen — which is how the page puts the file back after it has re-read it
 * from the server. Under a live composition that is destructive: the keyboard
 * holds a composition anchored where the text was, the document is swapped, and
 * the commit lands wherever the keyboard still believes it is. The page guards
 * the re-read on there being nothing unsaved, and a composition that has begun
 * and not yet changed the document is not yet unsaved anything — so the guard
 * has a gap exactly one request wide.
 */
const handOver = (page, line1) =>
  page.evaluate((text) => {
    const lines = window.__editorView.state.doc.toString().split('\n');
    lines[0] = text;
    window.__setContent(lines.join('\n'));
  }, line1);

const FROM_THE_SERVER = 'line 1 — as the server has it';

test('a document handed over during a live composition does not land under it', async ({
  page,
}) => {
  await ready(page);
  const client = await page.context().newCDPSession(page);
  const before = await held(page);

  await select(page, DOCUMENT_LINE(1).length);
  // A composition begun and deliberately not committed.
  await client.send('Input.imeSetComposition', { text: 'bon', selectionStart: 3, selectionEnd: 3 });
  await handOver(page, FROM_THE_SERVER);

  // Still the reader's line, with their composition in it: the new document is
  // waiting rather than in place.
  const during = await held(page);
  expect(during.split('\n')[0]).toBe(`${DOCUMENT_LINE(1)}bon`);

  await client.send('Input.insertText', { text: 'bonjour' });

  const after = await held(page);
  // The word arrived where it was typed, and nothing else moved. Without the
  // wait it committed into the middle of the line below, splicing itself into
  // text nobody had touched.
  expect(after).toBe(before.replace(DOCUMENT_LINE(1), `${DOCUMENT_LINE(1)}bonjour`));
  expect(after).not.toContain(FROM_THE_SERVER);
});

test('a document handed over while nothing is composing replaces it at once', async ({ page }) => {
  await ready(page);
  const before = await held(page);

  await handOver(page, FROM_THE_SERVER);
  await expect
    .poll(() => page.evaluate(() => window.__editorView.state.doc.line(1).text))
    .toBe(FROM_THE_SERVER);

  // Only the line the server differed on, and the rest of the file as it was:
  // waiting for a composition must not have become waiting for anything else.
  expect(await held(page)).toBe(before.replace(DOCUMENT_LINE(1), FROM_THE_SERVER));
});
