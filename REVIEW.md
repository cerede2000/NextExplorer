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
