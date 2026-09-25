# Upstream

How the work in this fork reaches `nxzai/NextExplorer`, what is left, and how
the remaining subjects are cut so that the plan published in nxzai#373 closes at
thirty-three and not at forty.

## Where this stands

| Batches | State                                                     |
| ------- | --------------------------------------------------------- |
| 1–9     | Merged 9 September 2026 (nxzai#374–#385).                 |
| 10–20   | Merged 25 September 2026, in order (nxzai#396–#406).      |
| 21–25   | Open, stacked, CI green (nxzai#410–#414). Merge in order. |
| 26–33   | Below.                                                    |

Measured against `origin/main` with 21–25 applied, what remains in
`backend/src` and `frontend/src` is about 101,000 lines, of which 13,500 are
the fifteen translation catalogues. That number is not eight features' worth of
work: a large part of it is structural — this fork split the file store into
modules, rewrote the folder view, the context menus and the dialogs — and that
divergence is not a subject of its own. It rides inside the batch that needs it,
or it stays here. See "What is not in the thirty-three".

## How the count closes

One subject, one number. The rule that keeps the total honest:

- **A batch that proves too large is split into several pull requests under the
  same number** — 28.1, 28.2 — never into a new number. The numbering describes
  the plan, not the delivery.
- **Nothing discovered on the way gets a number.** A defect found while porting
  is fixed inside the batch that owns the file, and named in that batch's pull
  request. Three of the five open ones carry such a fix (a document emptied by
  an unfinished download, a symbolic link rewritten to point at the source tree,
  a share counting page loads as downloads).
- **Each batch carries its own strings and its own documentation.** The
  catalogues are not a batch: a screen arrives with the fifteen languages it
  needs, or it arrives untranslated and no batch can be said to be finished.
- **What is not in the list is stated as not in the list**, rather than waiting
  to become batch 34.

## The eight that remain

Each one is a capability somebody can see, with its server side, its screens,
its strings and its documentation. Sizes are the code to port, catalogues
excluded, rounded.

### 26 — The text editor, and a history that can be read

**≈ 3,600 lines.** `textEditorService`, `routes/versions` and `versionsAdmin`,
`versions/index`, compressed text responses, reading the text of a file that is
in the trash; `EditorView`, `CodeSurface`, `VersionsPanel`,
`SettingsFileVersions`, the panel's store.

The engine merged in #406 keeps what a save replaces; #410 made the office
editors feed it. Nothing shows a history yet, and the text editor — the other
thing that saves over a file — is not there at all. They belong together: the
panel without a creator shows empty histories, and the editor without the panel
keeps what it writes invisible.

Depends on #406 and #410. Nothing else depends on it, so it can go first.

### 27 — The trash, finally visible

**≈ 2,300 lines.** `TrashView`, `TrashMenu`, `TrashContextMenu`,
`SettingsTrash`, the wording of the delete dialogs, the destination picker used
by "restore to"; and with it two listing corrections this fork made: a row that
forgets what the server has stopped saying about it, and the space a name is cut
on, which the listing dropped.

The trash engine has been merged since #405 with no interface whatsoever: an
administrator can configure a retention nobody can see the effect of, and a
deleted file is recoverable only through the API. This is the largest gap
between what upstream can do and what it shows.

Depends on #405. Best after 26, because the trash view shows version marks.

### 28 — Opening a document

**≈ 3,000 lines, ≈ 1,800 of tests.** The rest of ONLYOFFICE: the document key
store so a reopened document is not served from the Document Server's cache,
editing sessions and presence, Save as, renaming from the title bar, mentions in
comments, the co-editing settings, the transfer confirmation; `/open/<path>` and
the preference that sends documents to a tab of their own; and the tab titles,
which name the page and the instance.

Depends on #410. The key store is what makes a second save of the same document
correct, so it should not wait much longer than that.

### 29 — Uploads that resume

**≈ 2,400 lines.** The tus protocol (`@tus/server`, `@tus/file-store`), the
upload engine on the client side, the sweep of what a stopped upload leaves in
the cache, folder uploads and their target resolution, the uploads settings
screen and the progress panel.

Deliberately kept out of #413, which ported only what tus needs underneath — the
storage guard — because the protocol without its client proves nothing. This is
the batch that brings both halves.

Depends on #413. Adds two backend dependencies and two on the client, which is
worth saying plainly in the pull request.

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

Independent of the rest. A good one to take when the others are waiting on
review.

### 32 — Signing in another way

**≈ 2,300 lines.** Two-factor authentication (TOTP, recovery codes), passkeys
(WebAuthn, written here without a dependency), the SQLite session store, the
account screens for both; and the language an account reads in, which is an
account preference and belongs with them.

Depends on nothing but the account tables. The session store is the piece to
land carefully: it changes where sessions live.

### 33 — What an administrator sees, and what search answers

**≈ 7,100 lines**, of which about 3,000 are the OpenAPI description. API tokens
and the published description, the activity log and its screen, access rules
that say whether they hold administrators and the lock a restricted folder
carries, volumes that cannot be written in, the capabilities endpoint, the
folder-size and search-index screens, the excluded paths; and the search work
this fork did for nxzai#11 — forgetting an excluded folder in batches rather
than in one blocking pass, a content search that stops reading at what the page
can hold, and finding a path by bounds on bytes rather than by `LIKE`, which
ignores case and made `Docs` and `docs` the same folder.

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
  panel. Where upstream's equivalent works, it stays as it is; the pieces a
  batch genuinely needs travel with that batch and nothing more.
- **The screens that only exist because of a fork feature** already listed as
  out — nothing beyond what the eight batches carry.
- **Anything found from here on.** It is fixed inside the batch that owns the
  file, or it is written down here as out.

## The gates every batch passes

Unchanged from batches 10–25, and stated in each pull request:

1. The changed files pass lint and formatting — with the errors already present
   on `origin/main` subtracted, not silenced.
2. `npm run build`, and every backend module loads. These are the two steps
   upstream's CI runs, so a batch that fails them fails in public.
3. The whole backend suite, compared against the two failures that already exist
   on `origin/main` untouched (`auth.test.js` "current password is incorrect",
   `browse-hidden-files.test.js`). Nothing new fails, and the count of tests
   goes up.
4. Every claim has a test that fails when the change behind it is put back. A
   test that passes for the wrong reason counts as no test: two refusals in
   batch 21 were rewritten after mutation showed the network was doing the
   refusing.
5. Where the change is visible in a running instance, the image is built and
   driven — the office saves in #410 were checked that way, against a stand-in
   Document Server.

## Order

26 and 27 first: they give what is already merged its interface, which is what
an upstream user would notice. 28 next, because the document key store makes
today's office saves correct. Then 29, 30, 31 in whichever order review
allows — they touch nothing each other needs. 32 stands alone. 33 last, split,
because it is the widest and the least entangled with the rest.
