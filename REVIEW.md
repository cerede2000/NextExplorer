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
