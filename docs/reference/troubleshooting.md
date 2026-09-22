# Troubleshooting

Keep this page handy when deployment, authentication, or UI behaviors need quick fixes.

## Authentication & sessions

- **OIDC redirect errors:** Make sure your identity provider uses `${PUBLIC_URL}/callback` (or `OIDC_CALLBACK_URL`) as the redirect URI.
- **Session resets after restart:** Check that `/config` is persistent and writable by the server’s user, since the session secret generated when `SESSION_SECRET` is unset is kept there; the log says `Could not store the session secret` otherwise. Or set `SESSION_SECRET`.
- **Users logged out after browser restart:** Sessions persist by default for 30 days. If users are being logged out, check that `SESSION_SECRET`, or `/config/session-secret` when it is unset, stays the same. Adjust `SESSION_MAX_AGE_DAYS` to change the session duration.
- **Users not admin:** Confirm that the user's `groups`, `roles`, or `entitlements` include a value listed in `OIDC_ADMIN_GROUPS` (case-insensitive).
- **Cookies marked insecure behind HTTPS:** Ensure `PUBLIC_URL` uses `https` and your proxy forwards `X-Forwarded-Proto` and `Host`.

## Access & permissions

- **Path marked read-only or hidden:** Check Settings → Access Control for matching rules. A `hidden` rule applies to everyone, administrators included; an `ro` rule restricts every account except administrators, so test one with an ordinary account.
- **A rule seems to do nothing:** Its path must be the one NextExplorer shows, volume first (`torrents`, not `mnt/torrents`). The rule editor flags a path that names no folder and offers the folder probably meant.
- **A lock beside a volume:** Nothing can be written in it, and New, Upload and Delete are not offered there — to administrators either. Hover the lock for the reason: the volume is mounted read-only (`:ro` in the Compose file), the server's user may not write in it (match `PUID`/`PGID` to the owner on the host), or a rule or the volume's assignment keeps your account to reading.
- **Missing volume entries:** Confirm your `docker-compose` mounts include `/mnt/Label` entries and the container has read access.
- **Path not found after remounting:** Restart the container whenever you change volume mounts in your Compose file so the app rescans volumes.

## Search & thumbnails

- **Slow or missing search results:** Install or enable ripgrep. The official image bundles `rg`; custom builds need either the tool or fallback search (which may skip large files controlled by `SEARCH_MAX_FILESIZE`).
- **Thumbnails not generating:** Verify FFmpeg/ffprobe are available (paths override via `FFMPEG_PATH`/`FFPROBE_PATH`) and that `/cache` is writable.
- **Cache rebuild:** Clearing `/cache` keeps every account, share and setting, but signs everyone out, and the search index and folder sizes (`index.db`) are rebuilt by a pass over the volumes. Thumbnails come back as folders are visited.

## Reverse proxy issues

- **CORS errors:** See [Fixing CORS errors](/reference/cors) for `PUBLIC_URL` and `CORS_ORIGINS` guidance.
- **Public URL mismatch warning in UI:** If you see a `PUBLIC_URL` mismatch dialog, you’re visiting the app from a different URL than the server is configured for. Either access the app via the configured `PUBLIC_URL` domain or update `PUBLIC_URL` to match the URL you’re using and restart.
- **Websocket or upload failures:** Ensure the proxy forwards WebSocket upgrades and `X-Forwarded-*` headers.
- **Trust proxy misconfiguration:** Set `TRUST_PROXY` to `loopback,uniquelocal`, a number of hops, or explicit CIDRs depending on your topology.

## Updates & persistence

- **Settings lost after update:** Mount `/config` persistently; it contains `app.db`, `logos/` and `session-secret`. Back this folder up before upgrading. An installation that started on 1.1.7 or earlier kept `app.db` in `/cache`, and nothing moves it to `/config` any more; the server warns at start when it finds that file.
- **`/cache` filling disk:** `/cache` holds thumbnails, sessions and `index.db`. Deleting it reclaims the space at the cost above. `THUMBNAIL_CACHE_MAX_FILES` bounds the thumbnails and `RAW_PREVIEW_CACHE_MAX_FILES` the RAW previews; `SEARCH_INDEX_EXCLUDE` keeps folders nobody searches out of the index.

## ONLYOFFICE token errors

- "Document security token is not correctly configured" typically means the Document Server and nextExplorer share mismatched `ONLYOFFICE_SECRET`. Double-check the secret stored in `/etc/onlyoffice/documentserver/local.json` and update both sides to match.
- If `ONLYOFFICE_SECRET` is not set at all, nextExplorer signs with a secret derived from the session secret instead of reusing it, and logs a warning at startup. That derived secret stays the same as long as the session secret does: `SESSION_SECRET`, or `/config/session-secret` when it is unset. Deployments that relied on the old fallback — Document Server configured with the value of `SESSION_SECRET`, no `ONLYOFFICE_SECRET` — must now set `ONLYOFFICE_SECRET` explicitly on both sides.
