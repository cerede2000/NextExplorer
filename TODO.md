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
