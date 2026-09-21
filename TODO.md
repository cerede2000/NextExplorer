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

## Browsing inside an archive — done, and what it left

Answering "what is in this backup?" cost a full extraction. It now costs a
listing: `GET /api/archive/list` reads 7-Zip's table of contents, and
`GET /api/archive/entry` writes one file back without unpacking the rest.
Opening an archive in the browser shows what is in it, a level at a time.

What was decided in advance held, and is worth keeping written down:

- **The archive is an ordinary path and the position inside it is a separate
  parameter.** Not one virtual path like `/Work/pack.zip/inner/file`: twenty-six
  files resolve a path and every one of them takes what comes back for a real
  file. Nothing read out of an archive leaves the archive route.
- **Every name in an archive is hostile input**, and what one is allowed to mean
  is decided in a single function. An entry that climbs out with `..`, starts at
  the root or names a Windows drive is left out of the listing and counted, and
  the count is answered so a shorter listing is never a silent one.
- **Encrypted archives are out.** A table of contents behind a password says so
  (409); an entry whose contents are encrypted is listed and not handed over.
  Extraction is where a password is asked for.
- **A compound archive is decompressed once.** `.tar.gz` and its family are two
  archives, so the inner tar is written to `CACHE_DIR/archives` and read from
  there, with a budget and least-recently-opened eviction.
  `MAX_BROWSABLE_ARCHIVE_SIZE` (2 GB) is where the answer becomes "extract it
  instead", and it is checked against the size the outer archive declares —
  before anything is written.

### Left for later

- **Only what a browser draws from raw bytes is shown.** Text, Markdown and the
  images a browser decodes on its own are read in the panel; the answer stays an
  attachment and the page draws it itself, which is what keeps somebody's HTML
  out of this origin. What is not offered: video and audio, which would want
  ranges the entry endpoint does not serve; PDF, which would want an object or
  an iframe and so a decision about sandboxing; Office documents, which go
  through a converter that reads from the volume. Each is a separate decision,
  and none of them is this one.
- ~~**A solid `.7z` reads every entry from the beginning.**~~ Measured, then
  built. On a runner with a real 7-Zip, fifty megabytes in two hundred files
  that compress about two to one: reading the first entry takes 0.02 s, the
  middle one 0.70 s, the last 1.37 s — the cost is the entries before the one
  asked for. Extracting the whole archive takes 1.41 s, about what reading the
  last entry alone costs, and ten entries read one at a time take 6.95 s. So
  the second read of a solid archive extracts it once into the cache and every
  read after it is a file on disk; the first is left alone, because somebody
  who opens one small file near the front would otherwise wait 1.4 s instead of
  0.02 s for a tree nobody asks for again. The ceiling that already decides
  what may be browsed decides what may be extracted, and the cache's own budget
  and sweep now count directories as well as files.
  `scripts/measure-solid-7z.mjs` is the bench, and the workflow beside it runs
  it again on demand.
- **Nothing is offered but adding.** Extracting several entries and choosing
  where they land are both done. What is still missing: adding a file to an
  existing archive, and dragging one out of the panel onto the folder view.
  Both are operations on the volume, and each has to answer the overwrite
  question the rest of the application answers.

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

- **WebDAV: decided against, 16 September 2026.** Both others have it and it is
  the one row where that shows, so the cross in the comparison is owned rather
  than pending. NextExplorer is a file browser, not a server: something you
  open and use, not something other software mounts. A protocol is a second
  permanent way in, with its own way of proving who is asking, its own locks
  and clients writing whenever they like, and every rule about who may read,
  write or delete a path would have to hold on that side too — twice the
  authorization surface for a filesystem the container already reaches. What
  is mounted into the container is what this browses, the way a drive is a
  volume in Windows Explorer: an NFS or SMB share mounted on the host is
  already here, without this project speaking a protocol of its own. Reopen
  only if someone brings a case that mounting on the host cannot answer.
- **File versions against real office servers.** Versions are done on the
  trash's zone, journal and policy: capture on the four places the application
  overwrites a file, thinning, a shared budget, the Versions panel, share
  options, and the history inside ONLYOFFICE and Collabora (see
  `docs/admin/versions.md`). The office side is tested against the protocols —
  the callback, WOPI, the signed history payloads — not against a running
  Document Server or Collabora. Open a document's History in both, restore
  from it, and check a co-editor's next save is set aside, before calling it
  proven.
- ~~**An activity log.**~~ Done, and off unless somebody asks for it. Sign-ins
  (the refused ones included, with the name that was tried), sign-outs,
  downloads, what left through which share link, deletions, and every change to
  a password, a second factor or a passkey. Kept for a retention, swept hourly
  whether the log is on or off, and readable by administrators only. Two
  decisions worth keeping: no foreign key to the accounts, because what
  somebody did while their account existed is exactly what the log is for; and
  nothing in it may fail the request it describes, so a line that cannot be
  written is reported to the server's own log and the download carries on.
- ~~**Passkeys (WebAuthn).**~~ Done, and written here rather than taken from a
  package: the CBOR reader is checked against RFC 8949's published vectors and
  the ceremonies against a software authenticator built from the format, so the
  verifier can be taken apart one check at a time. Attestation is deliberately
  not verified — which company made the authenticator is not a file server's
  business — and the checks that matter are the challenge, the origin, the
  relying party, the flags, the signature and the counter. A passkey that was
  unlocked answers the second factor as well, because it is already two things.
  What it brought with it: no dependency at all.
- ~~**Two-factor on local accounts.**~~ Done. RFC 6238 written against its own
  published vectors rather than taken from a package, secrets kept unreadable
  in `app.db` under `/config/totp-key`, ten hashed recovery codes, and an
  administrator who can take it off an account that lost both the phone and the
  paper. What it brought with it: one dependency, `qrcode-generator` — zero
  dependencies of its own, a frozen algorithm, and it is handed our own
  `otpauth://` string and nothing a stranger supplies, which is the line the
  dependency audit drew.
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
holding the release for.

Every one of them was dealt with on 16 September 2026, each with the test that
holds it and a mutation that proves the test would have caught the old
behaviour. What the work found on the way is worth keeping:

- **A settings save no longer stores half of itself.** Each section is now
  checked in one step and written in another, and none of the writing starts
  until all of the checking has passed — the person's own preferences included,
  which used to be applied before the sections and survived a refusal further
  down.
- **An access rule whose path is nothing but spaces is refused**, and only when
  it is blank all through: a folder may legitimately be called "My Documents".
  The search index gained the sanitiser every other section had on its way into
  storage.
- **A logo an interrupted write left behind is swept**, under the same rule as
  the rest: the exact shape this application writes, never the listing.
- **The sign-in screen says whether single sign-on can work** before the button
  is pressed, in the two sentences the round trip used to bring back. One
  classification was wrong and is corrected: a missing client secret is a
  configuration that is missing, not a provider that could not be started.
- **A refused upload takes back the folders it created**, deepest first and only
  while each is still empty.
- **An upload that announces no size is measured.** This one was worse than the
  note suggested: a chunked body skipped the space check entirely, so the upload
  refused with 507 when it declared its length landed when it did not.
- **The ONLYOFFICE transfer question answers the one it replaces**, rather than
  leaving a transfer waiting for the life of the tab.

Still open, and needing somebody other than the code:

- **Two signed tokens outlive a password change, by decision.** ONLYOFFICE's
  backend tokens (12 h) and Collabora's WOPI tokens (6 h) reach one file with
  the rights written into them, and revoking one means state read on every
  operation of every open editor. `docs/admin/guide.md` says what a password
  change ends and what it does not, and how to end those sooner.
- **The first-hand check on the large-file report** — Edge on a Mac, by the
  server's local address. Chromium keeps a compressed answer only up to about
  6 MB; the second opening there should show a 304 in the network panel.
- **The download on a phone** — a long press, then Download, answered "session
  expired" and cancelled itself — is fixed here and not confirmed there: it was
  never reproduced in Chromium, whose requests survive the form's navigation.
- **The editor now reads with a GET**, so the file's path is in the access log,
  as `/api/raw` and `/api/versions` already put it.
- **One browser test failed once:** the share link read right after trashing its
  file answered `ECONNRESET` (run 35020703315). It passed on the rerun and in
  three separate local runs of the file.

## What the supply-chain audit of 16 September 2026 left to decide

The base image and 7-Zip were behind and were moved on the spot: node 24.16 to
24.21 (two Node security releases), 7-Zip 26.01 to 26.03 (CVE-2026-14266, a
heap overflow in the XZ decoder that upstream calls remote code execution, and
`xz`/`txz` are extensions this application offers to extract). Every other apk
package the runtime installs was checked against Alpine's secdb and every one
sits at or above its newest security fix. What follows did not have
an answer that could just be applied.

### The full image's ffmpeg — decided, and done

Alpine 3.23 was still on ffmpeg 8.0.1-r1, with none of the three CVEs upstream
fixed in 8.0.2 and 8.0.3 backported. The worst, CVE-2026-8461, is an
out-of-bounds write in the MagicYUV decoder scored 8.8, and MagicYUV travels in
Matroska and AVI — files this application hands to ffmpeg itself, to make a
thumbnail of whatever somebody uploaded. The lean image compiles 8.1.2 and was
never affected; the full image takes ffmpeg from the distribution.

The whole image moved to Alpine 3.24, whose community branch carries ffmpeg
8.1.2-r0: the Node base and the two stages that build 7-Zip and ffmpeg, which
link against that branch's shared libraries. Hardware acceleration stays, which
is what the full image is for — building ffmpeg from source there instead would
have cost it. What moved along: python3 3.12 to 3.14, nasm 2.16 to 3.01, and
mesa-va-gallium 25.2.7 to 26.1.6.

### Smaller, same audit

- **ffmpeg 9.0.1 is out**, and the source pin is on 8.1.2 — the newest patch of
  its own branch, so this is currency rather than a fix. Moving a major means
  re-running `docker/verify-ffmpeg.sh` for real, which is the point of it.
- **The published images are rebuilt weekly**, by `refresh-images.yml`: apk
  resolves against the branch head at build time, so an image says what was
  current on the day it was built and nothing more. It publishes the floating
  tags only — a version tag names a set of bytes somebody can pull again — and
  refuses the layer cache for the `runtime` stage, which is where apk installs
  ffmpeg, ripgrep and the rest and where a cache hit would have made the whole
  exercise pointless. Each run says what it produced, in its summary. Like
  every schedule, it does nothing until it is on `main`.
- **`demo/Dockerfile` builds from `ghcr.io/cerede2000/explorer:latest-lean`**,
  the one floating tag in the repository. For a demo that is meant to track the
  lean image it is the right dependency, but it does mean a demo build is not
  reproducible from the checkout alone.

## What the dependency pass of 16 September 2026 did, and what it left

`npm audit` at the repo root found eleven advisories. Four of them were in the
image, and none is now: `multer`, `sharp`, `adm-zip` and `joi` were closed
inside their current majors, and `vitest` took the patch for its own. Then the
five decisions that a version bump could not settle were taken, in this order.

The number to hold on to for next time: the root figure is not the figure.
The image runs `npm ci --omit=dev --workspace backend`, and the frontend
reaches it as a built `dist/` with no `node_modules` at all.
`npm audit --omit=dev --workspace backend` is the question worth asking, and
it answers nothing.

### Settled

- **`exifr` is gone**, replaced by `exif-reader` — no Perl, no Python, and one
  fewer read of the file: sharp already opens it for the dimensions and hands
  the EXIF block back with them. TIFF is read from disk, up to 32 MB, because
  there the file is the block.
- **Vite 5 to 7**, with the Vue, devtools and Tailwind plugins alongside it.
  The three dev-server advisories against the frontend's copy are closed.
- **`vue-i18n` 9 to 11**, the version its authors point at. Nothing this code
  used was removed on the way.
- **ESLint 8 to 10**, three `.eslintrc.cjs` files becoming one
  `eslint.config.mjs`. What the new rules found is in that commit.
- **Prettier runs in CI**, after 63 files had drifted with nothing checking.

### Still open, and why

- **`vitepress` keeps the last advisory alive.** 1.6.4 is the current release
  and it depends on `vite ^5.4.14` and `@vitejs/plugin-vue ^5.2.1`, so the
  path-traversal and `server.fs.deny` reports follow it. Forcing a newer vite
  underneath it would put two untested majors under a tool that drives vite's
  own SSR API. 2.0.0 is at `alpha.20`. The reach is `npm run docs:dev` on a
  contributor's machine; the published site is built output.
- **The browser baseline is now a decision, not a default.** Vite 7 would have
  raised it from Safari 14 to Safari 16 and Chrome 87 to Chrome 107 on its own.
  `build.target` in `frontend/vite.config.js` holds the old one until somebody
  decides who is still being served.
- **`no-await-in-loop` is not enabled.** The 206 disable comments that referred
  to it were removed with the rest of the dead ones. Turning it on for real
  would mean 168 new exceptions for sequential work that is deliberate.

### Packages that have stopped moving

Measured as last publish to npm and last push to the repository. None is
archived, none has had a release in years. Every one of them is now at its own
newest version, so this list is about maintenance, not about being behind.

- **`vuedraggable` 4.1.0** — the Vue 3 line, whose repository last moved in
  September 2023. `npm outdated` gives its "latest" as **2.24.3**, because the
  tag still points at the Vue 2 build: being told to go backwards is the
  clearest statement of its condition. Used by `FavMenu.vue` to reorder
  favourites.
- **`flatpickr` 4.6.13** — published June 2022, 857 issues open. The expiry
  date picker in `ShareDialog.vue`, browser-side only.
- **`@coleqiu/vue-drag-select` 2.0.6-beta.1** — a scoped fork published January
  2024, with no `repository` field in its manifest and a beta as its newest
  version. It is the rubber-band selection in the folder view.
- **`@vicons/*` 0.13.0** — icon sets, last published December 2024. Build-time
  and inert.

None of the four reads anything a stranger supplies, which is what separated
`exifr` from them and got it replaced first.

### Smaller things found on the way

- **`archiver` is at 8**, so `glob@8` and `inflight@1.0.6` — the package npm
  itself calls unsupported and leaking memory — are out of the container. It
  was never executed there: only `archive.glob()` would have, and this code
  calls `append`, `file` and `symlink`. Version 8 is ES modules and exports
  classes, which is the whole of the migration.
- **`prebuild-install` 7.1.3 is marked "No longer maintained"** upstream. It
  arrives with `better-sqlite3` and `node-pty`, so nothing at this level
  decides it.
- **`docs/package-lock.json` is a second lockfile inside a workspace.** npm
  installs from the root one and never reads it, so it can only drift.

## What the two-factor work found on the way

- ~~**A 401 on the sign-in screen loses its translation.**~~ Done, the second
  way: the handler no longer calls it an expiry when nothing expired. It
  answers `'expired'` for a session that ended, `'quiet'` for a 401 on the
  sign-in screen — an answer to what somebody typed — and `false` for anything
  that is not its business. A quiet one keeps the translated message and the
  code the server sent, and raises no toast, because the screen says it under
  the field. A wrong password read "Invalid credentials." on a French screen
  for as long as that path existed; it reads "Identifiants invalides" now.

## Choosing what gets logged — decided against, 17 September 2026

Asked whether an operator should be able to pick which kinds of event the
activity log records. Checked what the others do, in their sources and manuals
rather than their marketing:

- **Quantum** — 26 kinds, recorded by default, one switch
  (`database.activity.disabled`) plus retention and buffering. Narrowing by
  kind or scope happens when the log is read.
- **Nextcloud `admin_audit`** — every listener registered unconditionally, no
  config read anywhere in `Application.php`. The official answer on the forum
  is to comment out classes or filter the file with `jq`.
- **Nextcloud's Activity app** — `Data::send()` is called unconditionally; the
  per-type settings govern notifications and mail, not what is stored.
- **Seafile Pro** — `[AUDIT] enabled`, off by default, nothing else.
- **FileRun** — one switch for file activity plus a retention, off by default
  on new installations; who may _read_ it is per role.
- **Filestash** — no audit log in the open edition; `IAuditPlugin` is an
  extension point with no implementation in the repository.
- **Microsoft Purview** — on by default, all or nothing per tenant.

Nobody offers it. The shape is the same everywhere: one switch, a retention,
and rich filters at read time — which is what this already has. The value of
an audit trail is that it is complete, and the person who would want deletions
left out of it is the person it exists for. So: not built, and this is the
record of why rather than an omission to rediscover.

If it ever comes back, the only division worth having is FileRun's — the file
activity apart from the rest, because that is the privacy argument (knowing
who signs in and who shares a link is not the same as keeping a register of
every file a household opened) rather than an argument about volume.

## Node 26, when it is LTS and the three modules have caught up

Node 24 is the LTS this is built, shipped and tested on, and it is supported
until 2028 — so this is a move to make deliberately, not soon. Node 26 became
Current on 5 May 2026 and is due to become LTS in October 2026.

**What decided the date was not us, and it has now been decided.** Measured
on 19 September 2026, in the versions this tree ships: `sharp` is N-API and
takes any major; `better-sqlite3` 12.11.1 publishes `node-v137`, `v141` and
`v147`; `node-pty` published 141 and 147 in 0.14.1, on 23 July 2026, for
glibc and musl both. Node 26 is ABI 147, so all three are there.

What an archive accepts is no longer a sentence in `install.sh`. v3.9.3
widened it to "24 or 26" from what the modules publish on npm, which is a
different question from what one archive carries: `npm ci` resolves a single
SQLite prebuild, for the major that ran it, and the other major refuses it
with `NODE_MODULE_VERSION` seconds after the service starts. Reported from a
VM in [#9](https://github.com/cerede2000/NextExplorer/issues/9). The build
writes `NODE_MAJORS` into the archive now and the installer reads it, so the
promise and the bytes cannot disagree.

**What is left is what ships**: the image, the archive's bundled runtime, the
workflows and the manifests are still 24, and they should stay there until 26
is actually LTS in October 2026. Nothing forces the move before that; Node 24
is supported until 2028.

**When October comes**, it is one commit, and the test names what it misses:
`backend/tests/scripts/node-version-pinned.test.js` takes the major from the
root `package.json` and holds the rest to it — the image, the archive's
runtime, six workflows, three manifests, `.nvmrc` and the standalone page.
Move the range in the root manifest, run it, fix what it lists. The list an
archive accepts is not edited by hand any more: the build writes the major it
ran on into `NODE_MAJORS`, the installer reads it, and the test holds the two
file names together so a typo in either cannot go quietly wrong.

Two things to check rather than assume on the way:

- an installation already running on 24 has to keep updating after the move,
  so the first archive built on 26 is the one that stops accepting 24 — which
  now follows from what `NODE_MAJORS` says rather than from a line somebody
  remembers to change;
- `frontend/vitest.setup.js` carries a shim for Node 25's own `localStorage`,
  written when this repository was worked on from a machine running it. Node
  26's behaviour there is worth looking at before assuming the shim is still
  needed — or still enough.

## What the search work of 20 September 2026 did, and what it left

Reported in [#11](https://github.com/cerede2000/NextExplorer/issues/11) as a
search that returns by timing out, from an instance with a hundred thousand
documents indexed on an SMB mount and a file it could not find by typing its
name.

**The index answered contents and never names.** Filename search enumerated the
whole tree on every request, which is invisible on a local disk — fifty
thousand files answer in 143 ms — and is the entire cost on a network share,
one round trip per directory. Every file and folder has a row now, and a name
search reads it: at half a million rows a name that matches nothing takes about
40 ms. Measured on twenty thousand files, the pass costs 2% more wall time,
239 bytes of index per row and 6 MB of peak memory, and the pacing is
untouched.

Settled on the way, each with its own tests:

- four folder names an editor skips — `.git`, `node_modules`, `dist`, `build` —
  were hard-coded in the search _and_ in the indexer, so a folder somebody
  called `build` was unsearchable by name and by content;
- names are compared composed and lowercased, so `Résumé` finds a file a Mac
  wrote decomposed;
- a search inside a shared link answered nothing whenever the index was on: a
  share resolves inside the volume under another name, and the index was asked
  about a base it had never heard of — true for contents since the index
  existed;
- results are ordered: names by how close they are, contents by BM25 and then
  by path, which is what makes a folder's files arrive together;
- the answer says whether it was cut short and whether a full page is only the
  first of them, both of which the server had always known and never sent;
- three characters minimum, and the term is a prefix, so `azul` finds `azules`
  where it used to find nothing at all.

### Left open, with what decided it

- **Reaching the middle of a word through the index.** `ules` finds `azules`
  when the files are read and never when the index answers. Closing it means
  indexing every three-letter sequence instead of every word: measured at
  **11.3× the index and 4.5× the write** on three thousand documents. Not for
  this.
- **A share and a personal folder still walk the storage.** They resolve inside
  the volume under a name the index does not use, so the fix that made them
  correct sent them back to reading the tree — which is the cost this whole
  section removed everywhere else. Translating the base and rewriting the paths
  back is the shape of it, and it is where a leak would hide.
- **Nothing reaches past five hundred results.** Three steps ask for more; past
  that the answer is to narrow the search. A cursor would need a stable total
  order, which now exists, and a generator held open between requests, which is
  what was refused.
- **A one-row-per-folder catalogue is not a file listing.** Excluded folders,
  dot-folders and `_users` are not in it by design, so a reader who has asked
  to see hidden files is served by the walk.

## Open, not scheduled

- **Serve HTTPS from a certificate somebody already has** — `TLS_CERT` and
  `TLS_KEY`, two paths, the way Quantum takes `tlsCert`/`tlsKey` and filebrowser
  takes `--cert`/`--key`. Asked for in [#13](https://github.com/cerede2000/NextExplorer/issues/13),
  where what was wanted was a certificate this application generates for itself;
  that part is refused and the issue is closed. Nextcloud does not terminate TLS
  at all, and neither of the two above generates anything, so accepting a pair of
  paths is the whole of what the neighbours do.
  The catch to answer before writing it: a Let's Encrypt certificate is renewed
  every sixty days, and a process that read the file at boot goes on serving the
  old one until it restarts — Quantum and filebrowser both have that defect. So
  it is either watching the two files, or a reverse proxy, which is what the
  documentation says today and what handles redirection from port 80, HTTP/2 and
  renewal anyway.
- The repository is still marked as a fork of `nxzai/NextExplorer`; detaching it
  is a request to GitHub support.
- `demo/content/` holds 28 KB across seven files, so the gallery and thumbnails —
  some of the best parts of the application — do not show on the demo. A few
  freely licensed photos committed there would fix it without the 81 MiB sample
  archive.
