# Upstream

How the work in this fork reaches `nxzai/NextExplorer`, what is left, and how
the remaining subjects are cut so that the plan published in nxzai#373 closes at
thirty-three and not at forty.

## Where this stands

| Batches               | State                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| 1–9                   | Merged 9 September 2026 (nxzai#374–#385).                                      |
| 10–20                 | Merged 25 September 2026, in order (nxzai#396–#406).                           |
| 21–25                 | Open, stacked, CI green (nxzai#410–#414). Merge in order.                      |
| 26 first half         | Open (nxzai#415): the text save and the history API. Independent of the stack. |
| 27                    | Open (nxzai#416): the trash screen and its settings. Independent of the stack. |
| 26 second half, 28–33 | Below.                                                                         |

Measured with everything open applied, what remains in `backend/src` and
`frontend/src` is about 95,800 lines, of which 10,900 are the fifteen
translation catalogues. That number is not six features' worth of work: a large
part of it is structural — this fork split the file store into modules, rewrote
the folder view, the context menus and the dialogs — and that divergence is not
a subject of its own. It rides inside the batch that needs it, or it stays here.
See "What is not in the thirty-three".

## How the count closes

One subject, one number. The rule that keeps the total honest:

- **A batch that proves too large is split into several pull requests under the
  same number** — never into a new number. Batch 26 is the worked example: #415
  carries the server half (a text save that keeps what it replaced, and a
  history that can be read), and the panel that shows that history follows under
  the same 26. The numbering describes the plan, not the delivery.
- **Nothing discovered on the way gets a number.** A defect found while porting
  is fixed inside the batch that owns the file, and named in that batch's pull
  request. Four of the seven open ones carry such a fix: a document emptied by a
  download that never finished, a text file written over directly, a symbolic
  link rewritten to point at the source tree, and a share counting page loads as
  downloads.
- **Each batch carries its own strings and its own documentation.** The
  catalogues are not a batch: a screen arrives with the fifteen languages it
  needs, or it arrives untranslated and no batch can be said to be finished.
- **What a batch cannot take, it names.** Each pull request says what it left
  behind and which batch will carry it, so the remainder is always written
  down somewhere other than in somebody's head. The current list is at the end
  of this file.
- **What is not in the list is stated as not in the list**, rather than waiting
  to become batch 34.

## What remains

Each one is a capability somebody can see, with its server side, its screens,
its strings and its documentation. Sizes are the code still to port, catalogues
and tests excluded, measured rather than guessed.

### 26, second half — The panel that shows a history

**≈ 2,200 lines.** `VersionsPanel`, `SettingsFileVersions`, the panel's store,
`EditorView` and its code surface, `textEditorService`, `routes/versionsAdmin`.

#415 made the histories real and readable through the API; nothing shows them.
This is the panel on a file, the administrator's list of every file that has
one, and the text service both want — reading a version as text, and reading a
file that is still in the trash, which #416 left out for the same reason.

Depends on #415. Nothing depends on it.

### 28 — Opening a document

**≈ 3,000 lines, ≈ 1,800 of tests.** The rest of ONLYOFFICE: the document key
store so a reopened document is not served from the Document Server's cache,
editing sessions and presence, Save as, renaming from the title bar, mentions in
comments, the co-editing settings, the transfer confirmation; `/open/<path>` and
the preference that sends documents to a tab of their own; and the tab titles,
which name the page and the instance.

Depends on #410. The key store is what makes a second save of the same document
correct, so it should not wait much longer than that. It also carries the one
thing #415 could not: telling an open document that the file was restored under
a new key.

### 29 — Uploads that resume

**≈ 2,450 lines.** The tus protocol (`@tus/server`, `@tus/file-store`), the
upload engine on the client side, the sweep of what a stopped upload leaves in
the cache, folder uploads and their target resolution, the uploads settings
screen and the progress panel.

Deliberately kept out of #413, which ported only what tus needs underneath — the
storage guard — because the protocol without its client proves nothing. This is
the batch that brings both halves. It adds two backend dependencies and two on
the client, which is worth saying plainly in the pull request.

### 30 — Thumbnails, RAW and the gallery

**≈ 1,700 lines.** The thumbnail queue with its priorities and its idle-only
prefetch, the cache cleanup, RAW previews, the client-side queue, the additions
to the thumbnails settings screen.

Depends on #411, which put the access decision on the URL: the queue hands out
the same signed URLs.

### 31 — Archives

**≈ 1,200 lines, ≈ 800 of tests.** Browsing inside an archive without
extracting it, the extraction cache, the archive routes and their NDJSON
streams, the preview and its entry reader, the password dialog.

Independent of everything else. A good one to take while the others are waiting
on review.

### 32 — Signing in another way

**≈ 3,200 lines.** Two-factor authentication (TOTP, recovery codes), passkeys
(WebAuthn, written here without a dependency), the SQLite session store, the
account screens for both; and the language an account reads in, which is an
account preference and belongs with them.

Depends on nothing but the account tables. The session store is the piece to
land carefully: it changes where sessions live.

### 33 — What an administrator sees, and what search answers

**≈ 7,600 lines**, of which about 3,000 are the OpenAPI description. API tokens
and the published description, the activity log and its screen — including the
purge entry #415 left out — access rules that say whether they hold
administrators and the lock a restricted folder carries, volumes that cannot be
written in, the capabilities endpoint, the folder-size and search-index screens,
the excluded paths; and the search work this fork did for nxzai#11: forgetting
an excluded folder in batches rather than in one blocking pass, a content search
that stops reading at what the page can hold, and finding a path by bounds on
bytes rather than by `LIKE`, which ignores case and made `Docs` and `docs` the
same folder.

This is the one that will be split. Expect 33.1 (search and the path bounds),
33.2 (activity log and access rules), 33.3 (API tokens and the description).
Same number.

## What is not in the thirty-three

Stated so the count closes:

- **The standalone archive and its packaging** — `packaging/install.sh`,
  `assemble.sh`, the release workflows, the image pruning scripts. A fork
  concern; upstream publishes images only.
- **This fork's own interface architecture** — the file store split into
  modules, the rewritten folder view, the quick actions, the clipboard progress
  panel, the destination dialog and the operations store. Where upstream's
  equivalent works, it stays as it is; the pieces a batch genuinely needs travel
  with that batch and nothing more. #416 is the example: the trash screen went
  over without the destination dialog, so restoring puts an item back where it
  came from and choosing another folder waits for the batch that brings the
  dialog.
- **Anything found from here on.** It is fixed inside the batch that owns the
  file, or it is written down here as out.

## Left behind so far, and by whom

Read this before starting a batch; it is where the deferred pieces live.

| Piece                                         | Left by    | Lands in                           |
| --------------------------------------------- | ---------- | ---------------------------------- |
| Reading a version as text                     | #415       | 26, second half                    |
| Reading the text of a file still in the trash | #415, #416 | 26, second half                    |
| The purge entry in the activity log           | #415       | 33                                 |
| Telling an open document it was restored      | #415       | 28                                 |
| Restoring into a chosen folder                | #416       | the file-operations batch (dialog) |
| Progress and cancellation for a running copy  | #412       | the same                           |
| The resumable upload protocol                 | #413       | 29                                 |
| ONLYOFFICE keys, sessions, Save as, mentions  | #410       | 28                                 |

## The gates every batch passes

Unchanged since batch 10, and stated in each pull request:

1. The changed files pass lint and formatting — with the errors already present
   on `origin/main` subtracted, not silenced.
2. `npm run build`, and every backend module loads. These are the two steps
   upstream's CI runs, so a batch that fails them fails in public.
3. The whole backend suite, compared against what `origin/main` gives on its
   own. Measure that baseline rather than trusting a note: on a full run `main`
   fails `auth.test.js` ("current password is incorrect") and
   `browse-hidden-files.test.js` every time, and `users.test.js` (lockout) and
   `userSearchService.test.js` (limit) under load — those two pass when run
   alone, before and after any of this. Nothing new fails, and the count of
   tests goes up.
4. Every claim has a test that fails when the change behind it is put back. A
   test that passes for the wrong reason counts as no test: two refusals in
   batch 21 were rewritten after mutation showed the network was doing the
   refusing.
5. **For a batch that is mostly screens, the image is the gate.** Upstream runs
   no frontend test suite, so there is nothing to add a unit test to: build the
   image, start it, and drive the screen in a browser — #416 was checked by
   deleting a file, finding it in the trash with its provenance, restoring it
   from the screen and watching the folder get it back.

## Order

26's second half and 28 first: they finish what is already merged or about to
be — a history nobody can see, and office documents whose second save is not yet
correct. Then 29, 30, 31 in whichever order review allows; they touch nothing
each other needs. 32 stands alone. 33 last, split, because it is the widest and
the least entangled with the rest.
