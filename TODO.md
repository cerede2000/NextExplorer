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

## Two users can end up sharing one personal folder

`utils/pathUtils.js` derives a user's personal folder name from
`USER_FOLDER_NAME_ORDER`, falling back to `id, username, email_local`. Nothing
guarantees the last two are unique:

- `username` has **no UNIQUE constraint**. The original schema had one
  (`db.js:240`); the migrated table does not (`db.js:283`), and no code checks
  for a duplicate — an OIDC provider supplies the value as it pleases.
- `email_local` cannot be unique by construction: `bob@a.com` and `bob@b.com`
  both yield `bob`. It sits in the fallback order permanently, so an OIDC login
  carrying no username lands there.

Two accounts that resolve to the same directory each see the other's private
files. A default install is safe — the default order puts `id` first, and ids
are unique — but [the environment reference](docs/configuration/environment.md)
recommends `username,id` outright, to reuse an existing `/home/<username>`
layout, without a word about duplicates being possible or what happens then.

Three ways out, and the choice is a real one rather than an oversight to
correct:

- **Enforce uniqueness on `username`.** The honest fix, and the intrusive one:
  a migration has to decide what to do with the duplicates it finds on an
  instance that already has them, and an OIDC provider that supplies a colliding
  username would then fail the login outright.
- **Refuse a non-`id` order** unless uniqueness is guaranteed. Safe by
  construction, but it breaks exactly the deployment the documentation
  recommends, on upgrade, for people who did as they were told.
- **Say it plainly in the documentation.** Cheapest, changes no behaviour, and
  leaves a sharp edge in place for whoever does not read the note.

Worth deciding deliberately. Until then the default is safe and the
recommendation in the documentation is not.

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
