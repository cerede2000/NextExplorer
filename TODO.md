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

## A TUS test that does not test what it says

`backend/tests/routes/tus-upload.test.js` has a case named _rejects TUS uploads
when chunked uploads are disabled_ which begins by setting
`chunkedEnabled: true`. It passes, so the 403 it asserts comes from somewhere
other than the setting its name points at — the `UPLOAD_CHUNKED_ENABLED`
environment variable, most likely.

It is also timing-sensitive: mounting `express-session` in that file's
`buildApp` turns the expected 403 into a 201, without touching the route.

This matters beyond tidiness. The crash fixed in 3.0.2 lived in the seam between
`express-session` and the upload server, and this suite fakes `req.user` and
mounts no session at all — so it could not see it, by construction. Mounting a
real session here would close that gap, once this case is understood and made to
assert what it claims.

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
