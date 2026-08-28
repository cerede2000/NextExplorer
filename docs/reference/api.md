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

Chunked uploads must be enabled on the server (`UPLOAD_CHUNKED_ENABLED=true`).
Where they are not, `POST /api/upload` takes an ordinary multipart body.

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

## Endpoint reference

| Area                | Endpoints                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Auth                | `GET /api/auth/status`, `/methods`, `/me` · `POST /api/auth/login`, `/logout`, `/setup`, `/password`        |
| Browsing            | `GET /api/browse/*`, `/api/volumes`, `/api/search`, `/api/metadata/*`, `/api/usage/*`                       |
| Files               | `POST /api/files/file`, `/folder`, `/rename`, `/copy`, `/move`, `/office-document` · `DELETE /api/files`    |
| Uploads             | `ALL /api/upload/tus*` · `POST /api/upload`, `/api/upload/folder-session` · `GET /api/upload/finalizations` |
| Shares              | `POST /api/shares` · `GET /api/shares`, `/shared-with-me`, `/:id` · `PUT`/`DELETE /api/shares/:id`          |
| Public share access | `GET /api/share/:token/info`, `/access`, `/browse/*`, `/file` · `POST /api/share/:token/verify`             |
| Previews            | `GET /api/preview`, `/api/thumbnails/*` · `POST /api/download`                                              |
| Archives            | `POST /api/files/zip/compress`, `/api/files/zip/extract`                                                    |
| Folder sizes        | `GET /api/folder-size/*` · `POST /api/folder-size/refresh/*`, `/batch`                                      |
| Favourites          | `GET`/`POST`/`DELETE /api/favorites` · `PATCH /api/favorites/:id`, `/reorder`                               |
| Editing             | `POST`/`PUT /api/editor` · `GET /api/raw`                                                                   |
| Admin               | `GET`/`POST`/`PATCH`/`DELETE /api/users` · `/api/users/:userId/volumes` · `GET`/`PATCH /api/settings`       |
| Permissions         | `GET /api/permissions/*` · `POST /api/permissions/chmod`, `/chown`                                          |
| Health              | `GET /api/healthz`, `/api/readyz`                                                                           |

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
