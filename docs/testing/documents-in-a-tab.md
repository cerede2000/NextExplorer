# Test plan — a document in a tab of its own

Two things here are worth checking by hand, and they are not the ones that look
hard. That a document opens in a browser tab is visible in a second. What is
easy to get wrong, and invisible when it is wrong, is what the server is told
when that tab is **closed** — a document whose editing session never ended goes
on being reported as open, and the next person to open it sees a lock that will
not clear for hours.

Automated coverage lives in `frontend/src/views/DocumentView.spec.js`,
`frontend/src/composables/navigation.newtab.spec.js`,
`frontend/src/plugins/preview/manager.spec.js`,
`frontend/src/plugins/onlyoffice/onlyofficePreview.plugin.spec.js`,
`backend/tests/routes/onlyoffice-session-end.test.js`, and one browser test in
`frontend/e2e/app/core-flows.spec.js`. This page is the part that needs two
browsers and a Document Server.

## 1. Nothing changes until it is asked for

With the preference **off** — which is how every existing account starts —
open a photograph, a PDF and a spreadsheet from a folder. Each opens over the
folder, as before. Close each one: you are back on the folder, on the file you
opened. Nothing about this should feel new.

## 2. An address exists either way

Whatever the preference says, a document has a URL. With the preference off,
open one and copy `/open/<path>` into a second tab by hand:

- it opens the same document, on its own;
- closing it lands on the folder the document is in, with the document
  selected;
- the address survives a reload, and can be kept as a bookmark.

Try one of each kind — a photograph, a video, a PDF, a Markdown file, an
archive, an office document. The point of this feature is that they behave the
same; a kind that does not belong here is a bug.

## 3. The preference

**Settings → Preferences → Open documents in a new tab.** Turn it on and save.

- Open a photograph: a **new browser tab**, at `/open/…`. The folder you opened
  it from is still there, untouched, behind it.
- Open three more documents: four tabs, all open at once, browsing carries on
  in the first. This is the whole request.
- A file only the text editor opens goes to `/editor/…` in a tab of its own, by
  the same rule.
- A folder is still a folder: it does not open a tab.
- Turn the preference off: everything opens over the folder again.

## 4. The part that matters — an editing session that ends

This needs ONLYOFFICE configured, two browsers (or a browser and a private
window) signed in as two different accounts, and the folder listing open in
both.

1. In the first browser, with the preference **on**, open a `.docx`. It opens
   in a tab of its own.
2. In the second browser, look at the same folder: the document is marked as
   being edited, naming the first account.
3. Type something in the document. Do not save.
4. **Close the tab.** Not the document, the tab — the cross on the tab itself.
5. In the second browser, the mark clears once Document Server lets the
   document go, exactly as it does when the panel is closed. It does not hang
   around for the session timeout.
6. Open the document again: **what was typed is there.** The last save was
   asked for on the way out.

Then the same again, with the preference **off** and the document in a panel,
closing it with the button. The two have to behave identically — that is what
`/api/onlyoffice/session-end` exists for, and the one thing this whole page is
really checking.

Finally, the awkward ones:

- Close the tab **while a save is in flight**: nothing is lost, and the mark
  still clears.
- Close the browser outright, with the document's tab open: same.
- Reload the document's tab rather than closing it: the session ends and starts
  again; the document is still there and still editable.
- Two tabs on the **same** document, from the same account: they co-edit, and
  closing one leaves the other working.

## 5. What the second tab is allowed to be

Three things that are invisible when they are wrong. All three are held by the
browser suite; this is what they mean, and what to try if you want to see them
fail.

- **The tab cannot reach back.** It is opened with `noopener`, so
  `window.opener` in it is `null`. Without that, a page in the second tab could
  navigate the first one somewhere else.
- **The beacon arrives as somebody.** Closing a tab sends one request to end
  the editing session, and it has to carry the session cookie — a beacon that
  arrived as nobody would be answered `401` and the document would stay marked
  as open until it timed out. Same-origin, so `SameSite=Lax` does not stand in
  its way; a beacon another site sent would not carry the cookie, which is
  what makes this safe rather than what makes it work.
- **The address is worth nothing without an account.** `/open/<path>` is a URL,
  so it will be copied and pasted. Open one in a private window: the sign-in
  screen, and not a word of the document.

And one the tokens page also covers: **an API token cannot reach the editors at
all** — not `/api/onlyoffice/*`, not `/api/collabora/*`. A token has no
browser, so it has no editing session; a write token holding a session
identifier could otherwise end a colleague's, and one calling `/config` could
mark a document as being edited by a script that is not editing it.

## 6. Inside a share

A share is its own space — its paths are `share/<token>/…` rather than a
volume's — so it is the place a preference like this quietly fails to apply.

- Signed in, browsing a share of your own: the preference holds, and the
  document opens at `/open/share/<token>/…` with its content coming through the
  share. Covered by the browser suite.
- Following a share **link** with no account: the panel, as before. The
  preference belongs to an account, and a visitor has none — check the share
  still opens its document the way it always did.
