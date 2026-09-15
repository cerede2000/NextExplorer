# TODO

Work that is decided but not started. Not a backlog of ideas — things we intend
to do, with enough context to pick them up cold.

## The same rule applied four times, in the folder-size index

Exclusion of a folder is enforced in four places: `touch` skips a marked
directory, `flush` filters the dirty set again, `pruneExcludedIndexEntries`
deletes excluded rows at startup, and `aggregateDirectory` returns null for an
excluded path. Removing any pair of them leaves an excluded folder out of the
index all the same — verified by removing the two in `folderSizeManager`
together, which changed nothing observable.

The protection against indexing a folder mid-copy has the same shape, twice
over rather than four times: removing either guard alone changes nothing, and
removing both does.

The document search had the same shape and turned out not to: its bound is
enforced once per content engine, and only one engine runs per request, so a
machine without ripgrep installed exercised one of the two and the other looked
free to delete. The fix there was to name each enforcement at both ends and to
run the bound tests on both engines, which is worth trying here before removing
anything — four enforcements in one service that all run in the same request is
a different case, and may genuinely be three too many.

What cannot stay is the present state, where a test can pin the property and
nothing can pin the code — and where deleting a line that looks load-bearing
costs nothing and tells you nothing.

## Letting someone comment on a document without editing it

The ONLYOFFICE editor already offers comments and track changes — they are the
Document Server's, not ours, and they are on for anyone who may edit. Two things
were fixed to stop them being on by accident: `permissions.comment` is now
stated rather than inherited from `edit`, and `editorConfig.mode` no longer
follows `canEdit`. That second one is the whole reason a comment-only reader was
impossible to express: `mode: 'view'` loads a viewer, and a viewer has no
comment UI however the permissions read.

What is left is the access model, and the hard part is not the editor config.

**Commenting is writing.** A `.docx` keeps its comments inside its own OOXML, so
a reader who may only annotate still causes the file on disk to be rewritten.
`onlyoffice.js` decides `canEdit` before signing the backend token and the
callback trusts that flag rather than re-resolving permissions — deliberately.
Granting comments therefore needs a third state in that token, not a looser
boolean. With a boolean there are only two outcomes and both are wrong: refuse
the save and the comment is lost when the editor closes, or allow it and
"read-only" no longer means anything.

**It is not a level between `ro` and `rw`.** Access rules are `rw | ro | hidden`
and the content really does stay read-only, so a fourth level would lie about
what it permits. It belongs as its own attribute.

**Shares are where the need actually is**, and where the model already fits:
they carry granular booleans (`allowDelete`, `allowUpload`, `allowCreateFile`),
so `allowComment` sits beside them without touching volume rules. The use case
is sending a document out for review to somebody who has no account.

**Identity decides whether it is worth having.** `user.id`/`user.name` is
already sent, guests included as `guest_<id>`. On a public share that makes
every comment read as "Guest", which is unusable for a review with more than one
reader. A commentable share needs either a name asked for at open time or a
share issued to a named person — a product decision, not a code one.

**And say out loud what is trusted.** A save authorised by `comment` is trusted
to contain only comments, because ONLYOFFICE enforces that in the editor and the
JWT secret is what stands behind the callback. Verifying it server-side would
mean diffing two OOXML documents. That is the same trust already extended for
edits; it should be a decision, not an omission.

Order: `allowComment` on shares, then the third state in the token, then volume
rules only if the need shows up there.

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
- **File versions against real office servers.** Versions are done on the
  trash's zone, journal and policy: capture on the four places the application
  overwrites a file, thinning, a shared budget, the Versions panel, share
  options, and the history inside ONLYOFFICE and Collabora (see
  `docs/admin/versions.md`). The office side is tested against the protocols —
  the callback, WOPI, the signed history payloads — not against a running
  Document Server or Collabora. Open a document's History in both, restore
  from it, and check a co-editor's next save is set aside, before calling it
  proven.
- **An activity log.** Who downloaded what, when, from which share. The share
  counters are already in the database; what is missing is the table, the
  retention and the page. This is the feature that decides whether a deployment
  can account for itself, and Filestash sells it at the top of its range.
- **Two-factor on local accounts.** With OIDC the provider handles it. Without
  — the simplest mode, and therefore the most common — a password is all that
  stands in front of an entire filesystem. TOTP is a small amount of code for a
  disproportionate gain. Nobody has asked for it, upstream or here, but Quantum
  already offers it — password and 2FA are in its README — so this is catching
  up, not getting ahead.
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
beforehand, and that index exists now — `search_terms`, a contentless FTS5
table the search indexer keeps current — so OCR would feed it, off by default.

## What the code audit of 2 September 2026 decided

The [full report](https://claude.ai/code/artifact/da8cc67c-dc48-48fa-bca2-f878ed783280)
has the measurements. The order it set — a route suite first, then the two
changes that needed one underneath — has been followed to the end:

- **Tests for the ten route modules that had none — done.** What they turned
  up is in the commits: a rule written twice, answers of 500 where 404
  belonged, an unreachable branch, and tests of my own that passed whether the
  guard existed or not. One thing worth carrying: `authorizeAndResolve` never
  returns a resolved path when it refuses, so every `if (!allowed || !resolved)`
  has a second half no test can reach. It guards the contract; do not spend an
  hour trying to cover it.
- **Express 4 → 5 — done.** The backend runs on 5.2.1, which closed the
  `express`, `body-parser` and `qs` advisories in one move.
- **Splitting `accessManager.js` — done.** The share decision and the
  authentication decision are each named questions of their own now; the
  longest function left in the file is `getVolumeAccess`, at 80 lines.
- **The frontend, continuously — a habit, not a project.** Branch coverage went
  from 16.1 % to about 58 %, and CI now holds every figure to a floor
  (`coverage-thresholds.json`) and every change in behaviour to a test in the
  same commit. The next states worth seeing are in the files the CI summary
  ranks weakest: the Settings screens and the wrappers still at zero.

### Worth doing, not blocking

- **Load Uppy when a file is chosen, not when a page opens.** The last large
  thing in the main chunk, now that the preview plugins and the terminal load on
  demand: 2.33 MB and 655 kB gzipped, of which Uppy is a few hundred kilobytes
  carried by every page — the folder view, the settings, the shares — because
  `BrowserLayout` calls `useFileUploader()` on mount and the composable runs
  `new Uppy()` at the top.

  It is not the one-line change the terminal was, and it is worth writing down
  why before somebody starts it:

  - **Three entry points share one instance.** `BrowserLayout` holds the global
    one, `CreateNew.vue` opens the file dialog, `FolderView.vue` binds the drop
    target. All three have to land on the same Uppy, whichever runs first.
  - **Construction is not passive.** It installs the `files-added` handler, a
    pre-processor that reserves a folder's destination _before_ any bytes are
    sent, the choice between XHR and tus, and a progress watchdog. Deferring
    construction defers all of that, and nothing may reach the network before it
    is back.
  - **Drag-and-drop is the hard case.** When a file lands on the window there is
    no acceptable moment to fetch a library. It wants preloading on
    `dragenter`, or the first drop is slow.

  The tests it needed first exist now: `composables/fileUploader.spec.js`
  covers the failure paths, the XHR/tus fallback and the folder reservation.
  What is left is the change itself — defer the construction, then try it in a
  browser with real files: a drop, and a whole folder.

  The prize is 150–200 kB gzipped on first load, once. It is the highest risk
  left on this list: a mistake here does not make a page ugly, it loses
  somebody's files or sends them to the wrong folder.

- **The last two complex functions in the frontend.** The audit's worst was 72
  and everything it named is done; these two are what is left above thirty.

  - `ExplorerContextMenu.vue` at **34**: the menu that decides which actions a
    selection may have. It is one long condition per entry — what is selected,
    how many, whether the destination allows it, whether an editor is
    configured — and it is the file that tells someone what they are allowed to
    do, so a wrong branch shows an action that then fails.
  - `fileStore.js` at **28**, inside a setup function of nine hundred lines. The
    complexity is not the interesting number here; the length is. Selection,
    sorting and the clipboard do not need the store's state and would test
    alone.

  The covering came first, as everything else this audit touched, and it is
  done: the context menu has its spec, and `fileStore` has seven — listing,
  navigation, deletion, editing, archives, failures, the thumbnail queue. What
  is left is the split, and it has grown: `fileStore.js` is 1,181 lines now and
  the context menu 912.

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

## What the coverage work of 15 September 2026 left open

Writing tests for the least covered code found three security defects (archives
carrying the trash zone and hidden paths, copy target names that climbed out of
their destination, and two ways into sign-in) and a dozen smaller ones, all fixed
with their tests. What follows was found at the same time and judged not worth
holding the release for. Each was reproduced; none is guessed.

- **Multer's refusals answer 500.** A logo of the wrong type or too large, and an
  upload over the size limit, arrive as server errors in the log. They are 400
  and 413, and should say so.
- **An unreachable identity provider reads as "OIDC is not configured".** The
  404 from `/api/auth/oidc/login` sends an administrator to the configuration
  when the provider is down.
- **What a refused upload leaves.** `ensureDir` runs before the landing folder is
  authorized, so a refused upload can create empty folders — a `.nextexplorer`
  one included, through a folder session's `sourceRoot`. Nothing is written in
  them, and the zone accepts a folder without its marker; still, a refusal should
  leave nothing.
- **Two things only API clients see.** An upload that took a suffix answers with
  the name it asked for, not the one it got; and several files in one request
  measure the free space once, before the first file has finished writing.
- **An access rule on `../Secret`** is dropped by the server without a word, and
  its row disappears from the page.
- **Settings screens that trust the server to correct them:** an emptied chunk
  size sends 0, thumbnails have no bounds client-side, a negative default share
  expiry is accepted, and an empty application name is stored as empty.
- **A logo is replaced the moment it is chosen,** under a fixed name per type, so
  Discard cannot undo it and replacing a PNG with a PNG offers no Save at all.
- **Branding speaks English only**: its confirmation and upload messages are not
  in the catalogues.
- **The ONLYOFFICE transfer question** leaves the first promise unresolved if a
  second transfer asks while it is open. The dialog is modal, so this is
  theoretical.

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
