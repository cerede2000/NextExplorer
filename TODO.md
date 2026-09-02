# TODO

Work that is decided but not started. Not a backlog of ideas — things we intend
to do, with enough context to pick them up cold.

## Per-user API tokens, managed in settings

The HTTP API authenticates by session cookie only; `POST /api/auth/token`
answers `400 Token minting is disabled`. Anything driving the application from
a script therefore signs in as a user and holds a full session — there is no way
to issue a credential that is narrower than the account it belongs to, and no
way to revoke one without changing that account's password.

What it should become:

- A user issues tokens for themselves, from **Settings**, alongside the rest of
  their account.
- Each token is named, so it can be recognised months later, and shows when it
  was last used.
- Each is revocable on its own, without disturbing the account or the others.
- A token carries at most the permissions of the user who created it, and
  ideally less — read-only being the case worth having first.
- The value is shown once, at creation, and stored hashed.

Why it matters here: [the API reference](docs/reference/api.md) documents this
gap plainly, and automation against a self-hosted file server is exactly where
a stolen long-lived session cookie hurts most.

## Browsing inside an archive without extracting it

Answering "what is in this backup?" costs a full extraction today — forty
gigabytes written to disk to read one filename. FileBrowser Quantum lists this
as in progress and does not have it; Filestash does.

Half of it is already written. `readArchiveFootprint` runs `7z l -slt` before
every extraction, to refuse an archive that would expand beyond its limit, and
throws away everything in that listing except the sum of the sizes. Per-entry
records — path, size, date, whether it is a folder, whether it is encrypted —
are what the same output already carries.

**The shape that keeps it cheap:** a dedicated endpoint where the path is always
a real archive on disk and the position inside it is a separate, validated
parameter. Not a virtual path like `/mnt/Docs/pack.zip/inner/file`. Twenty-six
files call `authorizeAndResolve` or `resolvePathWithAccess`, and every one of
them assumes what comes back is a real file: renaming, deleting, uploading,
thumbnails, shares, folder sizes, the search index. Teaching all of them a new
kind of path is where the bugs and the holes would be.

Three things decided in advance:

- **Entry names come from the archive, so they are hostile input.** A crafted
  zip holds `../../etc/passwd`, or names with newlines in them. They are never
  used to build a filesystem path and never reach `7z` without validation.
  `assertNoSymlinks` guards what has already been extracted; this needs a guard
  before that.
- **Random access is real for zip and a lie elsewhere.** A zip has a central
  directory, so one entry costs one entry. A `.tar.gz`, a `.tar.xz` or a solid
  `.7z` decompresses from the beginning every time — and compound tarballs
  already take two passes here. Those formats are browsed by extracting once
  into `CACHE_DIR/archives/<fingerprint of path, mtime and size>`, with the
  TTL, size budget and eviction the thumbnail cache already models, and the
  single-flight lock `rawPreviewService` already uses. Never into the user's
  volume: it would show up in listings, be read by the search index, counted in
  folder sizes, and swept up by whatever backs that volume up.
- **Encrypted archives are out of the first version.** The password is
  deliberately kept out of `argv`, and holding one in memory for a browsing
  session is a new surface for a secret. Say so rather than improvise it.

`ARCHIVE_BROWSE_MAX_BYTES` refuses to browse what is too large to hold, and
points at the extraction that already exists. Browsing a forty-gigabyte archive
by unpacking it first would betray the whole point.

Costed at six and a half days, in three usable stages: listing (1 day), reading
one entry (1 day), the extraction cache (2 days), the panel and its thirteen
translations (2 days), documentation (half a day). The first stage plus a
minimal panel — about a day and a half — already answers the question that
started this.

## What the comparison against Quantum and Filestash found missing

Established in September 2026 by reading both projects' repositories and
documentation rather than their marketing. Two things worth keeping in view
while reading the list: FileBrowser Quantum states plainly that it does **not**
search file contents, which is the ground NextExplorer now holds alone among
the three; and Filestash's SSO, RBAC and audit are paid features, so a
comparison chart that ticks them without saying so is comparing a free green
box to one costing $290 a month.

Ordered by what the absence costs someone comparing the three today, not by how
hard each is.

- **WebDAV.** The most structural gap: it turns a website into a network drive
  — the Finder, the Explorer, a mobile app — and both others have it. The
  per-path authorization layer already exists; the work is serving WebDAV
  through it without going around it. High effort, and the security is where
  the care goes.
- **A trash.** A file manager with no net is one people distrust. Deletion here
  is final, which is coherent for something operating on a real filesystem, but
  it is a choice we ended up with rather than one we made. Done properly: a
  folder per volume, a retention period, and the space accounting that implies.
- **An activity log.** Who downloaded what, when, from which share. The share
  counters are already in the database; what is missing is the table, the
  retention and the page. This is the feature that decides whether a deployment
  can account for itself, and Filestash sells it at the top of its range.
- **Two-factor on local accounts.** With OIDC the provider handles it. Without
  — the simplest mode, and therefore the most common — a password is all that
  stands in front of an entire filesystem. TOTP is a small amount of code for a
  disproportionate gain.
- **Space quotas.** Needed the moment personal folders are opened to people who
  are not administrators. The recursive folder-size index already does the
  counting; a quota is that count, a limit, and a refusal in the right place.
- **An OpenAPI description.** The API reference is written by hand and every
  example in it was run, which reads better than a generated one and consumes
  worse: no generated client, nothing to explore. A description alongside the
  page would give both.
- **Tags.** The one I doubt. Both others have them and the FTS5 index could
  carry them for nothing, but a tag is only worth what people put into it, and
  in a tool whose files arrive by rsync or a network share, nobody puts any.
  Only if a real use asks for it.

And three that should **not** be pursued, recorded so the question does not
come back. Twenty storage protocols are Filestash's ground, built on a plugin
architecture from its first day; chasing S3 and SharePoint would dilute what
makes this useful — knowing one filesystem deeply — to arrive second somewhere
already occupied. Embedded OCR was costed and set aside: 40–70 MB of model per
language and one to five seconds a page. And removing the terminal to match
Quantum's choice is their security position, not a norm; ours is switchable by
variable, which is the right answer.

## Per-user rules for what opens with what

Which application opens a file is fixed by the environment
(`ONLYOFFICE_FILE_EXTENSIONS`, `COLLABORA_FILE_EXTENSIONS`, `EDITOR_EXTENSIONS`)
and by plugin priorities — ONLYOFFICE and Collabora at 50, markdown at 30, PDF
at 25, images at 20, media at 10, with the text editor reached only when no
preview matches. A user who wants `.csv` in the text editor rather than in
ONLYOFFICE cannot say so.

Not three lists of extensions but **one table of rules**: a line per extension,
a single destination. The conflict of an extension appearing in two lists then
cannot happen, and the markdown preference above becomes its first row.

Two things decide whether this is any good:

- **Pre-fill for display, never for storage.** Storing today's inherited values
  freezes them: an extension added to `ONLYOFFICE_FILE_EXTENSIONS` later would
  never reach anyone who had opened the screen, and one removed on purpose would
  stay with them. Keep `null` meaning "inherit" until the user actually changes
  a row — the motif `skipHome` already uses — so Reset restores inheritance
  rather than writing a copy of the current defaults.
- **Offer only destinations that exist.** Without `ONLYOFFICE_URL` its routes
  are not mounted at all, so listing it would promise what the server cannot do.
  The text editor already refuses binaries with a 415; say so in the field's
  help rather than letting people discover it.

No security dimension: what opens a file does not change who may read it.

## Cleaning up what points at a volume that is gone

Startup reports favourites, shares, recent destinations and folder preferences
whose volume is not available, and removes nothing — an NFS mount that is not
ready yet looks exactly like a volume someone deleted, and only a person can
tell them apart. Favourites now show it too, greyed out with a tooltip. What
remains:

- **An explicit admin action.** A "clean up orphaned references" button that
  first _lists_ what it would remove — this volume, that many favourites, that
  many shares — and asks for confirmation. The judgement that a volume is not
  coming back stays human; the admin just no longer needs sqlite to act on it.

Recent destinations and the destination picker still list a missing volume
without saying so; only favourites are marked.

## OCR for scanned documents

A scanned PDF is a picture of a page. Its text is read by nobody — not by
`pdftotext`, which finds no text layer, and not by any search that follows.
Making it searchable means optical character recognition.

Deferred on cost, not on interest. What it would take, measured rather than
guessed:

- **The image grows by 40 to 70 MB for a single language** — tesseract and
  leptonica, the language data (about 4 MB for a fast model, up to 15 for an
  accurate one), and a PDF rasteriser, because the image ships none: PDFs are
  excluded from thumbnails precisely so that none is needed. Each further
  language adds its own data. The `lean` variant exists to avoid weight of
  exactly this kind, so this would be the full image only, or a third variant.
- **One to five seconds per page**, depending on the processor. A twenty-page
  scan is half a minute to two minutes, for one document.

That second figure decides the shape of it: OCR cannot happen while someone
waits for search results. It only makes sense against an index built
beforehand — so this waits on [full-text indexing](#full-text-index-for-search)
and would be off by default when it arrives.

## Full-text index for search

Searching contents means walking the tree and reading files on every query.
It works, and it does not rank: results come in the order they are found.

SQLite's FTS5 is already available in `better-sqlite3` — no service to run, no
dependency to add — and `snippet()` produces exactly the matched line the
results already show. The hooks to keep an index current exist too:
`folderSizeHooks` is called on every write, replace and rename, `pathBindings`
follows moves, and the folder-size index is a working model of periodic
reconciliation for whatever changes outside the application.

Two things to decide before starting:

- **What is stored.** An FTS5 table that keeps the text is roughly a fifth to a
  half of it; a contentless one stores only the terms and is far smaller, at
  the cost of re-reading the file to show the matched line — which is no cost
  at all, since the path is right there.
- **Permissions.** The index does not know who may read what, so results are
  filtered after the query rather than in it, exactly as the live search does
  now.

## What the code audit of 2 September 2026 decided

The [full report](https://claude.ai/code/artifact/da8cc67c-dc48-48fa-bca2-f878ed783280)
has the measurements. What follows is the order the work goes in, and it is not
the order of severity: **two of the three most valuable pieces cannot be done
safely until the first one exists.**

### 1. Tests for the ten route modules that have none of their own — done

All ten are done. What they turned up is in the commits: a rule written twice,
two places answering 500 where 404 belonged, an unreachable branch, and six
tests of my own that passed whether the guard existed or not.

Some are traversed indirectly by other suites, which is why coverage is not
zero — but nobody has written down what they must answer. The four done so far
went from 18–28 % of statements and 0 % of branches to 66–87 % and 26–75 %, and
each turned something up: a rule written twice, a 500 where a 404 belonged, and
three tests of my own that passed whether the guard existed or not.

This was the net the next two steps hang from. Backend coverage went from 65.3 %
of statements and 54.4 % of branches to 69.1 % and 57.9 %.

One thing learned worth carrying: `authorizeAndResolve` never returns a resolved
path when it refuses, so every `if (!allowed || !resolved)` in the codebase has a
second half no test can reach. It is a guard against the service changing that
contract, not a branch with a case behind it — do not spend an hour trying to
cover it, as I did twice.

### 2. Express 4 → 5, on its own branch

Closes three of the four remaining advisories at once — `express`, `body-parser`
and `qs` are one chain, and no other fix exists for them. A framework migration
without a route suite underneath is how something breaks in a way nobody finds
for three weeks. After step 1, not before.

### 3. Split `accessManager.js:176`

Fifty-three possible paths through the function that decides who may do what.
Into named predicates, each testable on its own. Same rule: after step 1.

### 4. The frontend, continuously

16.1 % of branches. This is a habit, not a project — a branch nobody executes in
a test is a state nobody has seen, and in an interface those are the empty
folder, the refused permission, the interrupted upload. First slice: the error
states of `fileStore`. Five states, five tests.

### Worth doing, not blocking

- **Split the bundle.** 2.68 MB in one chunk, 745 kB gzipped. The terminal and
  the preview plugins are the largest pieces and the least often used; dynamic
  `import()` for those three is half a day and shows up on first load.
- **Finish the translations.** No key is missing in any of the thirteen
  catalogues, but 41 to 65 strings per language are still the English text —
  `editor.wrapLines`, `errors.deleteShare` and the like. Korean has five, German
  sixty-five; the gap says which have been read by someone.
- **`FileIcon.vue:205` is a lookup table written as branches** — 72 paths for a
  mapping from extension to icon. It wants to be data.
- **Two pairs of screens that copy each other**: `SharedByMeView` /
  `SharedWithMeView` (103 lines across two clones) and the two exclusion
  settings pages (84 lines across three). The services behind the second pair
  were already reduced to one factory; the pages were not. They will diverge at
  the first fix made on one side only.

### Rules this audit set, for whoever picks the work up

- **Do not chase a coverage percentage.** A number that rises because the
  getters got tested protects nothing. Cover the states a defect would reach.
- **Test at the layer the guard lives in, and prove the test fails without it.**
  Two of the permissions tests passed with the guard removed — a share path is
  unreachable anyway, so the status code was the same either way. Only asserting
  the _reason_ made them bite.
- **Do not fix the 128 silent `catch` blocks in bulk.** None are empty and many
  are legitimate. The rule is for new ones: a `catch` that swallows says why it
  does, in a comment. `routes/collabora.js:309` is the model.
- **Do not update a major version because it is behind.** `p-limit` is four
  majors back and works. An upgrade without a reason is risk with no return.
  Upgrade to close an advisory, to get a feature, or not at all.
- **Do not let the docs describe the previous version.** Two settings pages
  described behaviour that had changed the same morning. A doc that is wrong is
  worse than a doc that is missing.

## Open, not scheduled

- `PACKAGE_CLEANUP_TOKEN` is not configured, so the weekly image cleanup runs
  and deletes nothing. It needs a PAT with `delete:packages`. More pressing now
  that every push to `main` publishes images.
- The repository is still marked as a fork of `nxzai/NextExplorer`; detaching it
  is a request to GitHub support.
- `demo/content/` holds 28 KB across seven files, so the gallery and thumbnails —
  some of the best parts of the application — do not show on the demo. A few
  freely licensed photos committed there would fix it without the 81 MiB sample
  archive.
