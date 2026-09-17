# Driving NextExplorer from the API

Everything the interface does, it does over HTTP. There is no separate or
reduced API for automation: the endpoints below are the ones the application
itself calls, so anything you can do by clicking, you can do with `curl`.

Every example on this page was run against the
[live demo](https://nextexplorer-demo.onrender.com) as written.

## Authentication

Sign-in returns a session cookie, and that cookie is the credential. Token
minting is deliberately disabled — `POST /api/auth/token` answers `400` — so a
script authenticates the same way a browser does, and keeps the cookie for the
rest of its work.

```bash
curl -c cookies.txt -X POST https://your-host/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

Pass `-b cookies.txt` on everything afterwards. The session lasts as long as
`SESSION_MAX_AGE_DAYS` (30 by default), so a long-running job does not have to
sign in repeatedly.

An account with two-factor authentication answers that call with
`{"totpRequired": true}` and no user: the password was right, and the session
is holding the sign-in rather than granting it. Finish it within five minutes
with the code from the authenticator, or one of the recovery codes:

```bash
curl -b cookies.txt -c cookies.txt -X POST https://your-host/api/auth/login/totp \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456"}'
```

Six digits are worth one sign-in and one recovery code is worth one use, so a
script cannot keep either. A wrong code answers `401` with
`AUTH_INVALID_TOTP_CODE` and counts against the same lockout a wrong password
does. `GET /api/auth/totp` says whether an account asks for one and how many
recovery codes it has left; `POST /api/auth/totp/start` and `/confirm` set one
up, `POST /api/auth/totp/recovery-codes` and `DELETE /api/auth/totp` need the
account's password, and `DELETE /api/users/:id/two-factor` is an administrator
taking it off an account that has lost both the phone and the paper.

### Passkeys

A passkey is a browser ceremony, so there is no useful `curl` for it: the
signature has to come from an authenticator that was handed a challenge this
server drew. The endpoints are `POST /api/auth/login/passkey/start` and
`/finish` to sign in, `GET /api/auth/passkeys` to list the ones on an account,
`POST /api/auth/passkeys/register/start` and `/finish` to add one, `PATCH
/api/auth/passkeys/:id` to rename it and `DELETE /api/auth/passkeys/:id` — with
the account's password — to remove it. `DELETE /api/users/:id/passkeys` is an
administrator taking every passkey off an account whose device is gone, beside
`DELETE /api/users/:id/two-factor`, which does the same for its second factor.

The `start` calls answer `{ options, origins }`: `options` is what
`navigator.credentials` expects, with every byte as base64url, and the
challenge inside it is spent by the matching `finish` and worth one ceremony.
A refusal is `401` with `AUTH_PASSKEY_REJECTED` — the same answer for a wrong
site, a stale challenge, a signature that does not hold and a credential this
server has never seen, because telling them apart would say which passkeys
exist here. A passkey that was unlocked signs in outright; one that was not
answers `{"totpRequired": true}` on an account that asks for a second factor,
and finishes at `/api/auth/login/totp` like a password does.

### The activity log

`GET /api/activity` (administrators) reads what was recorded, newest first:
`action`, `outcome`, `user`, `from`, `to`, `q`, `limit` narrow it, and `before`
— the `nextBefore` of the page before — is where to carry on from, so rows
arriving while somebody reads do not shift a page. `DELETE /api/activity`
empties it, answers how many rows went (`removed`) and writes one last line —
`admin.activity-clear`, naming who asked and that count — after the deletion,
so it is the only row to survive it. The answer also says whether the log is on
(`enabled`) and what kinds of event exist (`actions`); with it off, `events` is
empty because nothing was recorded. It is switched on at `PATCH /api/settings` with
`{"activity": {"enabled": true, "retentionDays": 90}}`.

It ends sooner if the account's password changes. `POST /api/auth/password`
signs out every other session of the account, and moves the one that made the
change to a new cookie, which its response sets — keep writing to the cookie
file (`-c cookies.txt -b cookies.txt`) on that call, or the next one answers
`401`. An administrator's reset, `POST /api/users/:id/password`, signs out
every session of that account. A job holding a session of an account whose
password changes has to sign in again.

The practical consequence is worth stating plainly: there is no way to issue a
credential scoped to a script. An automation holds a full user session, so give
it an account whose permissions match what it is meant to do, rather than an
administrator's.

## Listing what is there

```bash
# The volumes this user can see
curl -b cookies.txt https://your-host/api/volumes

# The contents of a folder
curl -b cookies.txt https://your-host/api/browse/Documents
```

`browse` answers with the entries, the resolved path, and what this user is
allowed to do there — `canWrite`, `canUpload`, `canDelete` and the rest — so a
script can check a permission instead of discovering it through a failure.

## Uploading a file

Uploads go through [TUS](https://tus.io), in two steps: create the upload, then
send the bytes. Metadata is a comma-separated list of `key base64-value` pairs.

```bash
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# 1. Create it. The response carries the upload's URL in the Location header.
curl -b cookies.txt -D - -X POST https://your-host/api/upload/tus \
  -H 'Tus-Resumable: 1.0.0' \
  -H 'Upload-Length: 23' \
  -H "Upload-Metadata: filename $(b64 'report.txt'),uploadTo $(b64 'Documents'),relativePath $(b64 'report.txt')"

# 2. Send the bytes to the URL it returned.
curl -b cookies.txt -X PATCH https://your-host/api/upload/tus/<id> \
  -H 'Tus-Resumable: 1.0.0' \
  -H 'Upload-Offset: 0' \
  -H 'Content-Type: application/offset+octet-stream' \
  --data-binary @report.txt
```

`uploadTo` is the destination folder and `relativePath` the path within it, which
is how a whole directory tree is sent: one upload per file, each carrying its own
`relativePath`, and the folders are created as they are needed.

Because it is TUS, an interrupted transfer resumes rather than restarts — ask
the upload URL for its `Upload-Offset` with a `HEAD` and continue from there.
That matters for large files over a connection you do not control.

Once every byte has arrived, the file is put in its folder, under `name (1)`
when the name is taken, never over a file already there. A `HEAD` answers
complete only once that is done. When the file cannot be put there, the
`PATCH` that finished it answers `500` (`507` when the volume is full), and a
later `HEAD` answers `423`, both with an `Upload-Finalize-Error` header holding
the reason as a URI-encoded sentence; a `HEAD` also tries the move again, and
answers complete once it succeeds. An upload placed before a restart is still
answered complete, to the person who sent it, for as long as an unfinished
upload would be kept (`TUS_INCOMPLETE_UPLOAD_TTL_MS`).

Chunked uploads must be enabled on the server (`UPLOAD_CHUNKED_ENABLED=true`).
Where they are not, `POST /api/upload` takes an ordinary multipart body, with
the files in `filedata` fields. A file larger than `MAX_DIRECT_UPLOAD_SIZE`, or
more files than `MAX_FILES_PER_UPLOAD` in one request, is refused with `413`
and a message naming the limit; a file in any other field is refused with
`400`. Nothing sent in a refused request is kept.

## Sharing

```bash
curl -b cookies.txt -X POST https://your-host/api/shares \
  -H 'Content-Type: application/json' \
  -d '{"sourcePath":"Documents/report.txt","sharingType":"anyone"}'
```

The reply carries `shareUrl` and `shareToken`. The URL is built from
`PUBLIC_URL` when it is set, and from the request host otherwise — which is the
reason to set it: a link built from an internal hostname is useless to whoever
receives it.

`sharingType` is `anyone` for a public link or `users` with a `userIds` list for
named people. `password`, `expiresAt` and the `allow*` flags narrow it further.

Delete with `DELETE /api/shares/:id` — the share's `id`, not its token.

## Moving and removing

```bash
# Copy or move
curl -b cookies.txt -X POST https://your-host/api/files/move \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"path":"Documents","name":"report.txt"}],"destination":"Archive"}'

# Delete
curl -b cookies.txt -X DELETE https://your-host/api/files \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"path":"Documents","name":"report.txt"}]}'
```

Deleting a path also forgets what was bound to it — favourites, recent
destinations, per-folder view and sort preferences, shares — for every user, not
only the one who asked. Renames and moves carry those bindings across instead of
dropping them, so a script that reorganises a tree does not leave dead
favourites behind it.

`POST /api/files/delete-impact` says what a deletion would affect before you
commit to it, and `POST /api/files/delete-stream` reports progress as it goes,
which is what the interface uses for large selections.

## Reading and saving a text file

`GET /api/editor?path=Documents%2Fnotes.md` answers `{ "content": "…" }`, the
path encoded in the query string. `POST /api/editor` with `{ "path": … }` in the
body answers exactly the same and remains for clients written against it;
`GET /api/raw?path=` answers the text alone, as `text/plain`. `PUT /api/editor`
with `{ "path", "content" }` saves, in the encoding the file already had. A file
larger than `EDITOR_MAX_FILESIZE` is refused with `400`, a binary one with `415`.

The reads by `GET` can be kept and asked again. They carry an `ETag` and
`Cache-Control: private, no-cache`; send the ETag back in `If-None-Match`, and
while the file is unchanged the answer is `304 Not Modified` with no body —
the server does not even read the file to give it. The ETag changes whenever
the file does: a save, another file moved over it, a write in place, including
one that puts the modification time back. Permission is checked first, so
someone who may no longer read the file is refused as before, whatever they
send. A browser does all of this on its own. `PUT /api/editor` answers with
the ETag the next read will carry, when the file it wrote is still the one in
place.

The shared editor, `GET /api/share/:token/editor`, answers the same way, and
its ETag also changes when what the share allows does — `canWrite`,
`canDownload` — so a visitor's copy never outlives a permission change.

Responses that carry a whole text file are compressed when they are over
32 KB and the request's `Accept-Encoding` allows it: brotli when it is offered,
which browsers do only over HTTPS, otherwise gzip. That covers the reads
above, the shared editor, and the text of a file in the trash or of an earlier
version (`GET /api/trash/items/:id/text`, `GET /api/versions/:id/text`), and
every one of them varies on `Accept-Encoding`. `curl --compressed` asks for it.
Nothing else is compressed by the application — downloads, previews, media and
progress streams go as they are, most of them already compressed.

## Looking inside an archive

`GET /api/archive/list?path=Work/backup.zip` answers what is at the top of an
archive, and `&inside=docs` what is in one of its folders. The archive is named
by its path like any other file, and where you are looking inside it is a
separate parameter — never one path with the archive in the middle of it.

```json
{
  "path": "Work/backup.zip",
  "name": "backup.zip",
  "inside": "docs",
  "entries": [
    { "name": "deep", "path": "docs/deep", "isDirectory": true, "size": null, "modified": null },
    {
      "name": "report.txt",
      "path": "docs/report.txt",
      "isDirectory": false,
      "size": 4096,
      "modified": "2026-09-16 11:22:33",
      "encrypted": false
    }
  ],
  "total": 12,
  "outside": 0
}
```

`total` is how many entries the whole archive holds; `outside` is how many were
left out because their names point outside it — a crafted archive can carry
`../../etc/passwd`, and no answer here ever presents one as a place.

`GET /api/archive/entry?path=Work/backup.zip&entry=docs/report.txt` writes that
one file back, as an attachment, without unpacking the rest. The name is looked
up in the listing first, so what comes back is an entry the archive holds under
exactly that name, or nothing.

It is always an attachment, and always `X-Content-Type-Options: nosniff`, even
where the answer is what the panel is about to show on screen: nothing out of
somebody else's archive is ever opened as a page on this origin. A client that
wants to display an entry reads the answer as data and draws it itself.

`POST /api/archive/extract` takes part of an archive out onto the volume,
into the folder the archive is in. The body names the archive and the entries
— `{ "path": "Work/backup.zip", "entries": ["docs", "notes.txt"] }` — with an
optional `"destination": "Work/Elsewhere"` for somewhere else on the volume,
authorized exactly as the default folder is, and refused before anything is
written if it is not a folder this caller may write in. A
folder stands for everything under it. It answers with the same stream of
events the other archive operations write (`start`, `progress`, `done`,
`error`), and the `done` event carries the name each entry landed under, which
is not always the name it had: nothing is ever replaced, so a name already
held becomes “name (1)”.

Reading an archive is not the right to write beside it: extraction is refused
unless the caller may create files and folders in the archive's own folder.

Both refuse with a code the caller can act on: `ARCHIVE_ENCRYPTED` (409) for an
archive or entry behind a password, `ARCHIVE_UNREADABLE` (422) for a damaged
one, `ARCHIVE_ENTRY_NOT_FOUND` (404), `ARCHIVE_BAD_POSITION` (400) for a name
that points outside the archive, `ARCHIVE_TOO_MANY_ENTRIES` (413), and
`ARCHIVE_TOO_LARGE_TO_BROWSE` (413) for a compound archive past
`MAX_BROWSABLE_ARCHIVE_SIZE`.

## Endpoint reference

| Area                | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                | `GET /api/auth/status`, `/methods`, `/me`, `/totp`, `/passkeys` · `POST /api/auth/login`, `/login/totp`, `/login/passkey/start`, `/login/passkey/finish`, `/logout`, `/setup`, `/password`, `/totp/start`, `/totp/confirm`, `/totp/recovery-codes`, `/passkeys/register/start`, `/passkeys/register/finish` · `PATCH /api/auth/passkeys/:id` · `DELETE /api/auth/totp`, `/api/auth/passkeys/:id`, `/api/users/:id/passkeys` |
| Browsing            | `GET /api/browse/*`, `/api/volumes`, `/api/search`, `/api/metadata/*`, `/api/usage/*`                                                                                                                                                                                                                                                                                                                                       |
| Files               | `POST /api/files/file`, `/folder`, `/rename`, `/copy`, `/move`, `/office-document` · `DELETE /api/files`                                                                                                                                                                                                                                                                                                                    |
| Uploads             | `ALL /api/upload/tus*` · `POST /api/upload`, `/api/upload/folder-session` · `GET /api/upload/finalizations`                                                                                                                                                                                                                                                                                                                 |
| Shares              | `POST /api/shares` · `GET /api/shares`, `/shared-with-me`, `/:id` · `PUT`/`DELETE /api/shares/:id`                                                                                                                                                                                                                                                                                                                          |
| Public share access | `GET /api/share/:token/info`, `/access`, `/browse/*`, `/file` · `POST /api/share/:token/verify`                                                                                                                                                                                                                                                                                                                             |
| Previews            | `GET /api/preview`, `/api/thumbnails/*`, `/api/media/tracks`, `/api/media/subtitle` · `POST /api/download`                                                                                                                                                                                                                                                                                                                  |
| Archives            | `POST /api/files/zip/compress`, `/api/files/zip/extract` · `GET /api/archive/list`, `/api/archive/entry`                                                                                                                                                                                                                                                                                                                    |
| Folder sizes        | `GET /api/folder-size/*` · `POST /api/folder-size/refresh/*`, `/batch`                                                                                                                                                                                                                                                                                                                                                      |
| Favourites          | `GET`/`POST`/`DELETE /api/favorites` · `PATCH /api/favorites/:id`, `/reorder`                                                                                                                                                                                                                                                                                                                                               |
| Editing             | `GET`/`POST`/`PUT /api/editor` · `GET /api/raw`                                                                                                                                                                                                                                                                                                                                                                             |
| Admin               | `GET`/`POST`/`PATCH`/`DELETE /api/users` · `/api/users/:userId/volumes` · `GET`/`PATCH /api/settings`                                                                                                                                                                                                                                                                                                                       |
| Permissions         | `GET /api/permissions/*` · `POST /api/permissions/chmod`, `/chown`                                                                                                                                                                                                                                                                                                                                                          |
| Health              | `GET /api/healthz`, `/api/readyz`                                                                                                                                                                                                                                                                                                                                                                                           |

ONLYOFFICE and Collabora endpoints exist only where those integrations are
configured; the routes are not mounted otherwise, and asking for them returns
`404`.

## What to expect back

Errors are JSON and carry a `requestId` that also appears in the server log,
which is what to quote when something needs explaining:

```json
{
  "success": false,
  "error": {
    "message": "Source path is required",
    "statusCode": 400,
    "requestId": "000ecace-e638-402c-af94-df6b0cdfe4a7"
  }
}
```

This API is not versioned. It is the interface's own API, and it changes with
the interface — pin an image version if you build something that depends on the
exact shape of a response.
