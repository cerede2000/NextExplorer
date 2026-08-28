# Review

Findings, not fixes. Each one names where it is, what is wrong, and what it
costs — so the decision to act on it can be made on its merits.

Severity is about consequence, not effort:

- **Defect** — behaves incorrectly, with a consequence someone would notice.
- **Fragility** — correct today, but built so that the next change breaks it.
- **Note** — worth knowing; not necessarily worth doing.

---

## Lot 1 — Shares and guest sessions

`routes/shares.js` (1146), `services/sharesService.js` (703),
`services/guestSessionService.js` (221). Reviewed first because it is the only
surface reachable without an account.

### D1 · Changing a share's password does not revoke access — Defect

`services/sharesService.js:359` writes a new `password_hash` and nothing else.
No guest session is invalidated anywhere: the only `DELETE FROM guest_sessions`
is the expiry sweep, and `guest_sessions` cascades on share deletion but not on
share update.

**What it costs.** Changing a password is what you do when a link has leaked.
Everyone already holding a guest session keeps full access for up to
`SHARES_GUEST_SESSION_HOURS` — 24 hours by default — and the owner has no way to
cut it short other than deleting the share outright.

Adding a password to a share that had none behaves the same way: visitors who
opened it while it was public carry on, unprompted.

### D2 · Password checks block the event loop, on a public route — Fragility

`services/sharesService.js:556` uses `bcrypt.compareSync`, and `:127`/`:360` use
`bcrypt.hashSync`. bcrypt is deliberately slow — roughly 100 ms at cost 10 — and
the synchronous form stops Node from doing anything else for that time.

`POST /:token/verify` is reachable without an account. The rate limiter at
`routes/shares.js:49` allows 20 attempts per 15 minutes **per IP**, so a handful
of addresses can keep the single thread busy in a way no other public route can.
The async `bcrypt.compare` exists and is a drop-in.

### D3 · `sharePasswordApplies` is false for an anonymous visitor — Fragility

`services/accessManager.js:14` requires `Boolean(user)`, so the function that
reads as "does this share's password apply?" answers **no** for the very
visitors a public password is meant for.

Nothing is exploitable today: `accessManager.js:212` separately demands a user
or a guest session, and `routes/shares.js:837` demands a guest session bound to
the share. But the protection now lives in two places under a name that suggests
one, and a future caller trusting the predicate alone would let anonymous
visitors past a password. It is a trap laid for the next person.

### D4 · Token generation has a modulo bias — Note

`services/sharesService.js:17` does `bytes[i] % 62` over bytes 0–255. 256 is not
a multiple of 62, so the first eight characters of the alphabet come up about a
quarter more often than the rest.

Ten base62 characters give roughly 59 bits; the bias costs a fraction of one,
and guessing a token remains out of reach. Worth correcting for the cost of two
lines, not worth alarm. The same line allocates `length * 2` bytes and uses half
of them — the remainder looks like the leftover of a rejection-sampling loop
that was never finished.

### D5 · Visitor IP addresses are recorded, and not documented — Note

`trackShareAccess` and `trackShareDownload` store `ip_address` and
`last_download_ip`, and every guest session keeps an IP and user agent for 24
hours. That is reasonable for an audit trail and it is what the share statistics
screen displays.

It is personal data collected about people who never signed up, and nothing in
the documentation says so. Anyone running this for others may need to.

### Checked and sound

Stated because a review that only lists problems says nothing about the rest:

- **No password bypass.** A guest session is created only where the share has no
  password (`routes/shares.js:647`) or after `verifySharePassword` succeeds
  (`:670`). The synthetic session at `:845` is reached only when the share has
  no password.
- **`accessManager` checks the whole chain** — expiry, sharing type, guest
  session bound to the right share, password for a signed-in non-owner — and
  fails closed on a sharing type it does not recognise (`:235`).
- **A malformed expiry is treated as expired** (`sharesService.js:602`).
- **Deleting a share deletes its guest sessions** (`ON DELETE CASCADE`).
- **Shared writes check `canWrite`** (`routes/shares.js:858`), and the editor
  route asks for it explicitly (`:952`).
- **Share permissions are capped by the underlying path permission**, so an
  admin marking a path read-only or hidden takes effect on existing shares
  immediately (`accessManager.js:242`).
- **A file share cannot be walked into.** Inner paths on a non-directory share
  are refused unless they name the file exactly (`routes/shares.js:813`).
- **No SQL is built by interpolation** anywhere in this lot.

---

## Lot 2 — Access control and path resolution

`services/accessManager.js` (427), `accessControlService.js` (56),
`authorizationService.js` (82), `utils/pathUtils.js` (613),
`middleware/authMiddleware.js` (197). The layer everything else rests on.

### D6 · Two users can end up sharing one personal folder — Defect

`utils/pathUtils.js:286` derives a user's personal folder name from
`USER_FOLDER_NAME_ORDER`, falling back to `id, username, email_local`. Nothing
guarantees those are unique:

- `username` has **no UNIQUE constraint**. The original schema had one
  (`db.js:240`); the migrated table does not (`db.js:283`), and no code checks
  for a duplicate — an OIDC provider supplies the value as it pleases
  (`users/oidcAuth.js:141`).
- `email_local` cannot be unique by construction: `bob@a.com` and `bob@b.com`
  both yield `bob`. It is in the fallback order permanently, so an OIDC login
  that carries no username lands there.

**What it costs.** Two accounts resolve to the same directory and each sees the
other's private files. The default order puts `id` first and ids are unique, so
a default install is safe — but the environment reference recommends
`username,id` outright, to reuse `/home/<username>`, with no mention that
duplicate usernames are possible and what happens then.

Worth deciding deliberately: enforce uniqueness on `username`, refuse a
non-`id` order unless uniqueness is guaranteed, or say plainly in the
documentation what the trade-off is.

### D7 · `assertRealPathWithinRoot` does not assert what its name claims — Fragility

`utils/pathUtils.js:162` returns — accepting the path — once it has walked above
the root without finding anything real. The comment explains why: the lexical
check "ran before we got here". All four callers do run it (`:172`, `:371`,
`:441`, `:565`), so nothing is wrong today.

But a function named `assert…WithinRoot` silently accepts `/etc/x/y` when none
of it exists, and its safety depends on a precondition it does not state, does
not check, and cannot enforce. The fifth caller is the one to worry about.

### Checked and sound

Verified by running the real resolver against hostile input, not by reading
alone:

- **Traversal is refused** — `../etc/passwd`, `a/../../etc` and `..` all throw.
- **An absolute path is contained, not honoured**: `/etc/passwd` resolves to
  `<volume>/etc/passwd`.
- **A symlink pointing out of the volume is refused**, and so is a _broken_ one
  aimed outside — judged on its target's name, since there is no real path to
  compare. A symlink staying inside is allowed.
- **`escape.txt/../outside.txt` normalises lexically** and stays in the volume,
  rather than resolving the link first and climbing from its target. That
  diverges from POSIX semantics, in the safe direction.
- **Symlinked roots work** (`/mnt` → `/volume1` on a NAS): both sides are
  resolved, or every request would be refused.
- **Symlink loops are bounded** at 32 hops.
- **Guest and user sessions coexist deliberately** (`authMiddleware.js:170`):
  the guest session is the only proof the visitor typed a share password, so
  dropping it for signed-in visitors would make that check unsatisfiable. Each
  access check prefers the user when both are present.

---

## Lot 3 — External process execution

`routes/search.js`, `routes/permissions.js`, `services/archiveService.js`,
`thumbnailService.js`, `fileTransferService.js`, `terminalService.js`. One
question throughout: can a filename become an argument?

**No defect found in this lot.** Stated plainly, because it is the answer.

### D8 · `convert` is the one call without a `--` separator — Note

`services/thumbnailService.js:705` puts `srcPath` first with no separator, where
every other call site in the codebase uses one. The path is absolute, so it
cannot be read as an option, and a format prefix (`msl:`, `ephemeral:` — the
ImageMagick class of problem) cannot apply to a string starting with `/`.

So it is safe, by a property of the input rather than by the guard the rest of
the code uses. Adding `--` would make it safe by construction and consistent
with its neighbours.

### D9 · Archive traversal is the libraries' promise, not ours — Note

Nothing in `archiveService.js` or `routes/zip.js` validates entry names before
extraction. That is delegated, and both delegates hold:

- 7-Zip is invoked with `-snl-`, which refuses to restore symbolic links from an
  archive — the sharper version of the same attack.
- `adm-zip` 0.6.0, the fallback when 7-Zip is unavailable, sanitises entry names
  (`util/utils.js:341`). **Verified rather than assumed**: an archive containing
  `../../escaped.txt` extracts as `escaped.txt` _inside_ the destination, and
  nothing is written outside it.

Worth a test of our own all the same. It is a property the application depends
on, currently guaranteed by a dependency version that a routine upgrade could
change without anyone noticing.

### Checked and sound

- **No `shell: true` anywhere**, and no `exec()` with a string for an external
  process. Every call passes an argument array. The `db.exec` hits are SQLite
  statements, not shells.
- **`--` where it matters**: ripgrep, rsync, `rm -rf`, and both 7-Zip
  invocations. The search one carries a comment naming the exact risk it
  prevents — `--pre=<cmd>` would run a command against every scanned file — and
  the argument builder is exported so that separator can be tested on a machine
  without ripgrep.
- **`chmod`/`chown` are argued rather than trusted**: account names validated
  before use, path absolute, array arguments, and a comment explaining why the
  missing `--` is acceptable there (BSD `chmod` rejects it).
- **Zip bombs are refused before extraction** on both entry count and declared
  size (`routes/zip.js:42`).

---

## Lot 4 — Transfers and uploads

`services/fileTransferService.js` (1060), `tusUploadService.js` (494),
`uploadService.js` (293), `renameService.js` (116),
`uploadFolderTargetService.js` (138). Data integrity: loss, overwrite,
cancellation, resumption.

### D10 · Only the optional upload path guards against filling the disk — Defect

`tusUploadService.js:417` refuses an upload when the temporary or destination
storage cannot fit it plus `UPLOAD_STORAGE_RESERVE`. `uploadService.js` — the
**default** path, since `UPLOAD_CHUNKED_ENABLED` is false out of the box — has
no such check at all.

So the protection covers the path a deployment opts into and misses the one it
gets by default. The documentation is honest about this (it says "when accepting
TUS uploads"), which makes it a gap rather than a false promise, but the
consequence is the same: a direct upload can fill the volume. Where `/config`
shares that filesystem, SQLite stops being able to write and the application
stops working — for everyone, not just the uploader.

### D11 · A `.uploading` file outlives the upload that made it — Defect

`uploadService.js:147` writes to `<final>.uploading` and renames on success.
Failures are cleaned up, but nothing survives a kill: there is no sweep at
startup and no periodic one, unlike TUS which has `cleanupExpiredUploads`.

The remains are also **visible**. The default hidden patterns are `.` and
`regex:\.download$` — the second exists precisely to hide another mechanism's
artefacts, and `.uploading` was never added. So a killed container leaves
`holiday.mp4.uploading` sitting in the folder, in the listing, for ever, and
nothing anywhere will remove it.

### D12 · Two upload paths, neither with a test — Fragility

`uploadService.js` (293 lines) and `renameService.js` (116) both write to disk
after authorising, and no test references either. Reading them found nothing
wrong — the authorisation chains are complete, and `renameService` checks the
parent, the source, the new name and the target in turn — but they are the two
modules where a regression would be silent.

### D13 · A TUS upload is not tied to whoever started it — Note

`tusUploadService.js:307` re-authorises the destination on every request rather
than checking who created the upload. Someone else who knew the upload id could
therefore write into it — but only where they may already write to that
destination, so they gain nothing they did not have.

The bound is real, and re-authorising each time is the right instinct. It is
listed because the notion of an owner does exist a few lines below (`:333`, for
the finalisation list), so the asymmetry is a choice worth being deliberate
about: two people with access to the same folder can currently corrupt each
other's in-flight uploads.

### Checked and sound

- **Nothing is overwritten.** An existing name goes through `findAvailableName`
  (`uploadService.js:143`).
- **The destination is authorised twice** — once for the chosen folder, once for
  the subfolder the client's relative path lands in, with a comment explaining
  that otherwise a read-only or hidden subfolder would still accept uploads
  (`:126`).
- **Uploading to the volume root is refused** (`:114`).
- **Multer's limits are all set**: file size, file count, field count, field
  size, header pairs (`:282`).
- **TUS requires authentication before anything else** (`:400`), and
  re-authorises the destination on every non-POST request.
- **`renameService` authorises the parent, the source and the target**, validates
  the new name, and refuses an existing target — despite having no test.
- **The documentation build is not committed** (`docs/.vitepress/dist` is
  ignored).

---

## Lot 5 — Folder size index

`folderSizeIndexer.js` (725), `folderSizeManager.js` (624),
`folderSizeIndex.js` (521), `folderSizeHooks.js` (347),
`folderSizeTransferState.js` (39), `folderSizeExclusions.js` (86). Around 2,200
lines of concurrent work — expected to be the richest lot, and it is the
soundest so far.

**No defect found.** The two failure modes worth hunting here — a lock nothing
releases, and an index that drifts — are both already handled, visibly on
purpose.

### D14 · A size that should have gone negative is silently clamped — Note

`folderSizeIndex.js:194` updates with `size_bytes = MAX(0, size_bytes +
@byteDelta)`. Clamping is right: a negative folder size would be worse than a
wrong one.

But reaching that clamp means a delta was missed or applied twice — a symptom of
a bug elsewhere — and the `ON CONFLICT DO UPDATE` branch does not set
`dirty = 1`, so the row is neither corrected promptly nor recorded as suspect.
The wrong value simply waits for the general reconcile pass, and nobody ever
learns the inconsistency happened. `dirty = CASE WHEN size_bytes + @byteDelta <
0 THEN 1 ELSE dirty END` would turn a silent absorption into a targeted repair
and a usable signal.

### D15 · 2,200 lines of concurrency, five tests — Note

`folderSizeIndexer` is referenced by two test files, `folderSizeManager` by
three. That is thin for the amount of state and timing involved.

It is mitigated deliberately rather than ignored: `docs/testing/folder-size-index.md`
is a written manual plan, published in the documentation, covering what
automated tests cannot easily reach here. Worth knowing that this is the
arrangement, so nobody assumes the automated suite covers it.

### Checked and sound

- **The in-memory transfer lock is released on all three paths** — success,
  cancellation, and an unexpected I/O failure. The last one carries a comment
  naming the exact hazard it avoids: "permanently suppressing size refreshes
  until the process restarts" (`fileTransferService.js:790`). Someone went
  looking for this before I did.
- **Nothing persistent is left stuck.** The row written before a directory
  transfer is marked `dirty = 1` (`folderSizeIndex.js:391`), so a process killed
  mid-transfer leaves a row the reconciler picks up rather than a state no
  restart clears.
- **Shutdown is orderly** (`folderSizeManager.js:372`): timers cleared, in-flight
  reconcile aborted, active subtree scan aborted, a final flush, and a `stopped`
  flag so a late timer callback cannot re-arm anything.
- **Timers are `unref`'d**, so the indexer never keeps the process alive.
- **Incremental drift has a designed answer**: periodic reconciliation, paced in
  batches and resumable through a cursor, so a missed event is corrected rather
  than accumulating for ever.

---

## Lot 6 — Editors and previews

`routes/onlyoffice.js` (1165), `routes/collabora.js` (408), the `onlyoffice*`
services, `thumbnailService.js` (1171). The interesting part is the **inbound**
surface: a Document Server calls us.

**No defect found.** The callback is where an unauthenticated write would live,
and three separate things prevent it.

### Checked and sound

- **The JWT check cannot be skipped.** It reads as conditional
  (`routes/onlyoffice.js:1040`, `if (onlyoffice.secret)`), but the secret is
  never empty: `config/index.js:328` falls back to a derived one, and `:343`
  warns at startup that it will not match the Document Server. Missing
  configuration therefore fails closed and says so, rather than opening the
  route.
- **A callback with no valid backend token falls back to the ordinary access
  check** (`:1105`), which needs a session with write permission — something a
  Document Server does not have. So even a forged callback writes nothing.
- **The backend token carries the permission**, and read-only sessions are
  refused explicitly (`:1099`) rather than trusted because they hold a token.
- **The save URL is constrained to the configured server** (`:1093`), so the
  callback cannot be turned into a fetch of any address the caller names.
- **Thumbnails are bounded**: a concurrency-limited queue, a 30-second timeout
  per item, `SIGKILL` on cleanup, and child processes niced down — reasonable
  for running ffmpeg and ImageMagick over files nobody vetted.

---

## Lot 7 — Authentication and OIDC

`routes/auth.js` (296), `middleware/oidc.js` (425), `services/oidcService.js`
(154), `users/localAuth.js`, `users/oidcAuth.js`.

### D16 · OIDC group membership is read once, at account creation — Defect

`users/oidcAuth.js:7` derives roles from the provider's `groups`, `roles` or
`entitlements` claims. It is called on the INSERT path only (`:141`). Every
returning login updates `display_name`, `username` and `email_verified` — and
never `roles` (`:75`, `:112`).

**What it costs, in both directions.** Someone removed from the admin group at
the identity provider stays an administrator here, for good. Someone added to it
never becomes one, no matter how many times they sign in.

The documentation reads the other way round: `docs/integrations/oidc.md:36` says
"the user is promoted to admin" if a claim matches, and its troubleshooting entry
for **"Not an admin after login"** tells the reader to check the claim and the
group name — advice that cannot work, because for an existing account the claim
is never consulted at all.

Whichever behaviour is intended — evaluate every login, or pin at creation so a
provider change cannot demote a local admin — the code and the documentation
currently promise different things.

### D17 · The OIDC middleware has no test at all — Fragility

`middleware/oidc.js` is 425 lines and no test references it; `oidcService.js`
(154) likewise. This is the path that decides who someone is, in the deployments
that use it, and a regression there would be both silent and serious.

### Checked and sound

- **Admin roles fail closed.** With no `OIDC_ADMIN_GROUPS` configured, the
  candidate list is empty and everyone lands on `['user']` — claims alone can
  never grant admin (`users/oidcAuth.js:23`).
- **An unverified email cannot take over an existing account.** Linking a new
  OIDC identity to an account that already exists requires a verified email
  claim, "regardless of the provisioning configuration" (`:92`) — the guard
  against a well-known account-takeover route.
- **Local sign-in is defended twice**: rate limiting on login, setup and password
  change (`routes/auth.js:60`), plus per-account lockout after repeated failures
  (`users/localAuth.js:21`).

---

## Lots 8 and 9 — Frontend

`stores/fileStore.js` (1181), `views/FolderView.vue` (1152),
`composables/fileUploader.js` (900), `components/ExplorerContextMenu.vue` (912),
`ShareDialog.vue` (769), and the rest of ~25,800 lines.

**No defect found.** The two classic front-end failures — injected markup and
leaked listeners — are both absent.

### D18 · A guest session id is readable by script — Note

`api/shares.api.js:121` keeps `guestSessionId` in `sessionStorage`, while the
server sets the same value as an **httpOnly** cookie
(`routes/shares.js:92`) — expressly so that a script cannot read it.

The copy exists for a reason: the API also accepts an `X-Guest-Session` header,
which is what makes a share link work where third-party cookies are blocked. And
the exposure is bounded — `sessionStorage` dies with the tab, and the only
`v-html` in the codebase is sanitised, so there is no obvious way to run a script
here in the first place.

Worth stating rather than fixing blindly: the httpOnly cookie buys protection
that the sibling copy partly gives back, and that trade was presumably made on
purpose.

### Checked and sound

- **The single `v-html` is sanitised.** `plugins/markdown/MarkdownPreview.vue:16`
  renders through `DOMPurify.sanitize(marked.parse(content))` — markdown files
  come from the volume and are not trusted.
- **The single `innerHTML` is a constant** — a drag icon, no interpolation
  (`composables/useFileDragDrop.js:180`).
- **No leaked listeners.** One file adds without removing, and both cases are
  sound: one is `{ once: true }`, the other is bound once behind a flag in a
  store that lives as long as the application.
- **Nothing sensitive is persisted** beyond the note above: a fallback chunk
  size, a locale, and an OIDC sign-out flag.

---

## Lot 10 — Infrastructure

`Dockerfile`, `docker/entrypoint.sh`, `.github/workflows/`, `scripts/`.

### D19 · GitHub Actions are pinned by tag, not by digest — Note

Every workflow uses `actions/checkout@v6`, `docker/build-push-action@v7` and so
on. A major-version tag is mutable: whoever controls the action's repository can
move it.

These workflows hold `packages: write` and the Docker Hub credentials, and they
build the images people run. That is the shape of a supply-chain problem —
pinning by commit digest is the usual answer, at the cost of a dependency bot to
move them along.

Listed as a note rather than a defect because tag-pinning is what nearly
everyone does, and the alternative has a real maintenance cost. Worth a
deliberate decision, not a silent default.

### Checked and sound

- **Base images are pinned to exact versions** — `node:24.16-alpine3.23`,
  `alpine:3.23`. No `latest` anywhere in the build.
- **The application does not run as root.** The entrypoint starts privileged
  only to remap ownership, then hands over with `gosu appuser`.
- **The 7-Zip binary is verified**: downloaded at a pinned version and checked
  against a SHA-256 before use.

---

## Summary

Ten lots, roughly 67,000 lines.

| Severity  | Count |
| --------- | ----- |
| Defect    | 5     |
| Fragility | 5     |
| Note      | 9     |

The five defects, most consequential first:

1. **D1** — changing a share's password revokes nothing for up to 24 hours.
2. **D16** — OIDC group membership is read once, so admin rights can neither be
   granted nor revoked afterwards, and the documentation says otherwise.
3. **D6** — two accounts can share one personal folder under a configuration the
   documentation recommends.
4. **D10** — the default upload path has no free-space guard; the optional one
   does.
5. **D11** — a `.uploading` file left by a killed process is visible and never
   cleaned up.

Three of the five are about **revocation and cleanup** — states that outlive
what created them — rather than about anything being computed wrongly. That is
the shape of this codebase's weak spot, and worth remembering when reviewing the
next change.

What is conspicuously solid: path containment (verified against hostile input
rather than read), external command execution (no shell anywhere, separators
where they matter), the folder-size index (both of its plausible failure modes
already found and handled), and the ONLYOFFICE callback (three independent
reasons an unauthenticated write cannot happen).
