<p align="center">
  <img src="docs/public/images/logo.png" width="96" height="96" alt="nextExplorer logo" />
</p>

<h1 align="center">NextExplorer</h1>

<p align="center">
  A modern, self-hosted file explorer with secure access control, polished UX, and a Docker-first deployment.
</p>

<p align="center">
  <a href="https://nextexplorer-demo.onrender.com"><b>Live demo</b></a> ·
  <a href="https://cerede2000.github.io/NextExplorer/">Documentation</a>
</p>

<p align="center">
  <code>demo@example.com</code> / <code>demo1234</code> — everything resets when the demo restarts.
</p>

## About this fork

NextExplorer was created by [Vikram Soni](https://github.com/vikramsoni2) and
developed at [nxzai/NextExplorer](https://github.com/nxzai/NextExplorer). That
repository has had no commits since 13 July 2026, and its documentation and demo
sites are offline — both are back here.

This fork carries the work that accumulated in the meantime — chunked uploads,
per-user access control, ONLYOFFICE integration, native transfers with progress,
and a good deal more — and is where issues are answered and releases are cut. It
remains GPL-3.0, like the original.

## Image variants

Two images are published, on both registries:

| Tag                         | Contains                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- |
| `latest`, `3.9.1`           | Everything, including hardware video acceleration (VA-API) and RAW photo support |
| `latest-lean`, `3.9.1-lean` | The same application without VA-API or RAW — a considerably smaller image        |

Take the full image unless you know you need neither: VA-API only helps where the host exposes a render device to the container, and RAW support only matters if you keep camera files. Both variants are built for `linux/amd64` and `linux/arm64`.

```
ghcr.io/cerede2000/explorer:latest
ghcr.io/cerede2000/explorer:latest-lean
```

They are also on Docker Hub under the same tags.

`latest` and `latest-lean` follow `main`, so a fix reaches them without waiting
for a release. Every build is also published under the version in
`package.json` — `3.9.1`, `3.9.1-lean` — republished for as long as that
version is current, and left alone once the next one is cut.

Only the last two versions stay published: on Docker Hub the older one is
removed as the next is published, and on GHCR a weekly job does the same. Pin a
version you intend to keep running and move it forward deliberately rather than
expecting an old tag to still be there.

## Highlights

- **Look inside an archive without unpacking it.** Open a zip, 7z, rar, iso, tar
  or tar.gz and browse it like a folder: go into its folders, read a text file,
  a Markdown file or an image inside it, and take one file — or one folder —
  out onto your volume, here or wherever you choose. The rest of the archive is
  never written to disk.
- **Deleting goes to a trash.** Restore where it was or into a folder you pick,
  restore part of a deleted folder, or empty it for good. The trash lives in
  each volume, so a 40 GB folder is deleted as fast as a small file.
- **Saving over a file keeps what it replaced.** Versions from the editor, from
  a share link, from ONLYOFFICE and Collabora — open one read-only, download it,
  restore it, or put it over another file. Thinned as they age, and pinned ones
  are kept.
- **Nothing is ever replaced silently.** Upload, copy, move, extract, restore:
  a name already taken becomes “name (1)”, and the interface says which name
  the file landed under.
- **Two-factor on local accounts.** Any authenticator app, ten recovery codes,
  and an administrator who can take it off an account that lost both.
- **Sign in with a passkey.** A fingerprint, a face or the device's PIN instead
  of a password. The key never leaves the device and what it signs names this
  site, so it cannot be phished, watched or replayed — and a passkey you
  unlocked to use answers the second factor as well. Written here without
  adding a dependency: the only library worth using exists to check which brand
  of authenticator you hold, which is the one thing this deliberately does not
  want to know.
- **An activity log, off unless you ask for it.** Who signed in — including who
  tried and failed, and under what name — what was downloaded, uploaded, sent
  to the trash, restored or removed for good, what left through which share
  link and what arrived through one, and every account or setting an
  administrator changed. Administrators read it, each line is kept for as long
  as the retention says, and emptying it leaves the one line saying who emptied
  it. On a machine one person uses it has no reader, which is why it is a
  switch rather than something that happens quietly.
- **Search that reads inside files.** A filename search as you type, patterns
  like `*.ps1`, and a full-text index that reads Office documents and PDFs.
- **Previews and editing.** Images, video, audio, PDF, Markdown, a code editor,
  and Office documents through ONLYOFFICE or Collabora.
- **Sharing.** Links with a password, an expiry and per-operation permissions,
  guest access, and “Shared with me”.
- **Access control.** Local accounts and groups, optional OIDC SSO, and rules
  per path with read, write and delete kept apart.
- **Docker-native.** One image, volumes under `/mnt`, reverse-proxy friendly via
  `PUBLIC_URL`.

## How it compares

Two projects solve the same problem from a different angle, and this is where
the three of us stand: [FileBrowser
Quantum](https://github.com/gtsteffaniak/filebrowser), the active fork of File
Browser, and [Filestash](https://www.filestash.app/), which speaks every storage
protocol there is. Every cell was read on 16 September 2026 from the project it
describes — its repository, its documentation, its pricing page — rather than
from anybody's marketing or anybody's chart.

✅ shipped · 🚧 announced by that project as coming · ❌ not offered · 💰 paid
tier · — not documented

### The project

|                                   | **NextExplorer 3.7** | **FileBrowser Quantum** | **Filestash**                                   |
| --------------------------------- | -------------------- | ----------------------- | ----------------------------------------------- |
| Licence                           | GPL-3.0              | Apache-2.0              | AGPL-3.0 (core)                                 |
| Price                             | Free                 | Free                    | Free — Pro from $50/mo, Enterprise from $290/mo |
| Interface languages               | 15                   | 26                      | —                                               |
| Docker image, amd64 and arm64     | ✅                   | ✅                      | ✅                                              |
| Official installer outside Docker | ✅ Linux archive     | ✅                      | 💰                                              |

### Archives, without unpacking them

|                                   | **NextExplorer 3.7**               | **FileBrowser Quantum** | **Filestash**    |
| --------------------------------- | ---------------------------------- | ----------------------- | ---------------- |
| Browse one like a folder          | ✅ zip, 7z, rar, iso, tar, tar.gz… | 🚧                      | ✅ viewer plugin |
| Read a file inside one            | ✅ text, Markdown, images          | 🚧                      | ✅ viewer plugin |
| Take one entry — or several — out | ✅ into any folder you pick        | ❌                      | ❌               |
| Compress a selection              | ✅                                 | ✅                      | ❌               |

### Getting data in and out

|                                | **NextExplorer 3.7**          | **FileBrowser Quantum** | **Filestash** |
| ------------------------------ | ----------------------------- | ----------------------- | ------------- |
| Chunked, resumable uploads     | ✅                            | ✅                      | ✅            |
| Upload a whole folder          | ✅                            | ✅                      | ✅            |
| Never replaces a file silently | ✅ “name (1)”, and it says so | —                       | —             |

### When something goes wrong

|                                               | **NextExplorer 3.7**        | **FileBrowser Quantum** | **Filestash** |
| --------------------------------------------- | --------------------------- | ----------------------- | ------------- |
| Trash, with restore                           | ✅                          | 🚧                      | ❌            |
| Restore part of a deleted folder              | ✅                          | ❌                      | ❌            |
| Earlier versions of a file                    | ✅                          | ❌                      | 💰 Enterprise |
| Versions from the office editors' own history | ✅ ONLYOFFICE and Collabora | ❌                      | ❌            |

### Finding things

|                                      | **NextExplorer 3.7**             | **FileBrowser Quantum** | **Filestash** |
| ------------------------------------ | -------------------------------- | ----------------------- | ------------- |
| Search by name, indexed, as you type | ✅                               | ✅                      | ✅            |
| Search inside file contents          | ✅ Office documents and PDFs too | ❌                      | ✅            |

### Viewing and editing

|                                         | **NextExplorer 3.7**      | **FileBrowser Quantum** | **Filestash** |
| --------------------------------------- | ------------------------- | ----------------------- | ------------- |
| Images, video and audio, in the browser | ✅                        | ✅                      | ✅            |
| Office documents                        | ✅ ONLYOFFICE / Collabora | ✅                      | ✅            |
| Text and code editor                    | ✅                        | ✅                      | ✅            |
| Folder sizes in the listing             | ✅                        | ✅                      | —             |

### Who gets in

|                                         | **NextExplorer 3.7**                 | **FileBrowser Quantum** | **Filestash** |
| --------------------------------------- | ------------------------------------ | ----------------------- | ------------- |
| Local accounts                          | ✅                                   | ✅                      | ✅            |
| OIDC single sign-on                     | ✅                                   | ✅                      | 💰 Enterprise |
| LDAP sign-on                            | ❌                                   | ✅                      | 💰 Enterprise |
| Second factor from an authenticator app | ✅ with recovery codes               | ✅                      | 💰 Enterprise |
| Passkeys (WebAuthn)                     | ✅ and they answer the second factor | ✅                      | 💰 Enterprise |
| Brute force on the sign-in              | ✅ account lockout                   | ✅ rate limiting        | —             |
| Access rules per path                   | ✅ read, write and delete apart      | ✅                      | 💰 RBAC       |

### Sharing

|                                     | **NextExplorer 3.7** | **FileBrowser Quantum** | **Filestash** |
| ----------------------------------- | -------------------- | ----------------------- | ------------- |
| Links with a password and an expiry | ✅                   | ✅                      | ✅            |
| Per-operation permissions on a link | ✅                   | ✅                      | ✅            |
| Guests can upload into a share      | ✅                   | ✅                      | ✅            |

### Running it

|                                     | **NextExplorer 3.7**        | **FileBrowser Quantum** | **Filestash**         |
| ----------------------------------- | --------------------------- | ----------------------- | --------------------- |
| WebDAV                              | ❌ by choice                | ✅                      | ✅                    |
| Storage beyond the local filesystem | ❌ by choice                | ❌                      | ✅ about 25 protocols |
| API tokens for scripts              | ✅ read-only or read-write  | ✅                      | ✅                    |
| Activity log                        | ✅ optional, off by default | ✅                      | 💰                    |
| Space quotas                        | 🚧                          | 🚧                      | 💰                    |
| Terminal in the browser             | ✅ switchable               | ❌ removed deliberately | ❌                    |

The rows where somebody else is ahead are in there for the same reason as the
rest. The one 🚧 left in our column is the answer to one of them. The two ❌
marked _by choice_ are decisions rather than gaps: NextExplorer is a file
browser, not a server — something you open and use, not something other
software mounts. What it browses is what the container was given: each
`/mnt/<Label>` is a volume the way a drive is one in Windows Explorer, so an
NFS or SMB share mounted on the host is already in here, without this project
speaking a protocol of its own. Twenty-five storage protocols are Filestash's
ground for the same reason, and arriving second on it would cost what this is
actually good at.

[The source for every row](https://cerede2000.github.io/NextExplorer/experience/features#how-it-compares)
is in the documentation.

The original [File Browser](https://github.com/filebrowser/filebrowser) is not
in the table: its own README says it was archived on 1 September 2026, with two
classes of security issue that will not be fixed. Quantum is its active fork.

## Install without Docker

Every release carries a Linux archive that installs the application as a
systemd service, for x86_64 and arm64. It brings its own Node runtime and its
own 7-Zip, so nothing has to be installed first and nothing is compiled:

```sh
tar -xzf nextexplorer-<version>-linux-x64.tar.gz
cd nextexplorer-<version>-linux-x64
sudo ./install.sh
```

It says which optional tools are missing — ffmpeg, ripgrep, pdftotext, perl,
rsync — what each one buys, and offers to install them through apt, dnf, pacman
or zypper. Updating is `sudo nextexplorer-upgrade`, which checks the next
release against its published checksum and leaves your configuration, your
database and your files alone. Running `install.sh` again from a newer archive
does the same.

[The full guide](https://cerede2000.github.io/NextExplorer/installation/standalone)
covers volumes, the systemd unit, and what differs from the container — chiefly
that the browser terminal is off, since outside a container it would open a
shell on the machine itself.

## Quickstart (Docker Compose)

```yaml
services:
  nextexplorer:
    image: ghcr.io/cerede2000/explorer:latest
    container_name: nextexplorer
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./config:/config
      - ./cache:/cache
      # Each /mnt/<Label> mount becomes a top-level volume in the UI
      - /path/to/your/files:/mnt/Files
    environment:
      - NODE_ENV=production
      - PUBLIC_URL=http://localhost:3000
```

<details>

<summary> Full docker-compose with all configurations</summary>

```yaml
services:
  nextexplorer:
    image: ghcr.io/cerede2000/explorer:latest
    container_name: nextexplorer
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./config:/config # contains config files, db, settings etc.
      - ./cache:/cache # thumbnails, sessions and index.db (search index, folder sizes): rebuildable, but keep it persistent

      # Each /mnt/<Label> mount becomes a top-level volume in the UI
      - /path/to/your/files:/mnt/Files

    environment:
      # Required basics
      NODE_ENV: production # Set to `production` for the Docker image defaults.
      PORT: '3000' # Port the Express API + frontend listen on *inside* the container.
      PUBLIC_URL: 'http://localhost:3000' # External URL (no trailing slash); drives cookies, CORS defaults, and derived callback URLs. Accessing the app via a different URL may cause CORS/cookie/OIDC issues.


      # Reverse proxy / networking (optional)
      # INTERNAL_URL: "http://192.168.1.250:3017,http://192.168.1.251:3017" # Extra origin(s) the app may also be reached from, comma-separated. They are accepted by CORS and OIDC returns to the origin used to start login. PUBLIC_URL stays canonical for share links and integrations. Register `${PUBLIC_URL}/callback` and every `${INTERNAL_URL}/callback` with your IdP.
      # TRUST_PROXY: "loopback,uniquelocal" # Express trust proxy config; set when running behind a reverse proxy (often auto-derived when `PUBLIC_URL` is set).
      # CORS_ORIGINS: "" # Comma-separated allowed origins; aliases: `CORS_ORIGIN`, `ALLOWED_ORIGINS` (defaults to `PUBLIC_URL` origin when set).

      # Logging & debugging (optional)
      # LOG_LEVEL: "info" # `trace|debug|info|warn|error` (defaults to `debug` when `DEBUG=true`).
      # DEBUG: "false" # When `true`, forces `LOG_LEVEL=debug` and enables more verbose diagnostics.
      # ENABLE_HTTP_LOGGING: "false" # When `true`, logs HTTP requests (recommended with centralized logs in production).
      # PERFORMANCE_DIAGNOSTICS_ENABLED: "false" # Log CPU, Node/cgroup memory, event-loop latency, thumbnail queues, and folder-size activity when a pressure threshold is reached.
      # PERFORMANCE_DIAGNOSTICS_INTERVAL_MS: "15000" # Sampling interval; at least 5000 ms.
      # PERFORMANCE_DIAGNOSTICS_LOG_EVERY_INTERVAL: "false" # Set `true` for a complete time series while investigating an issue.
      # PERFORMANCE_DIAGNOSTICS_CPU_THRESHOLD: "75" # Log a sample when the Node process reaches this CPU percentage.
      # PERFORMANCE_DIAGNOSTICS_RSS_THRESHOLD_MB: "768" # Log a sample when Node RSS reaches this level.
      # PERFORMANCE_DIAGNOSTICS_EVENT_LOOP_DELAY_MS: "250" # Log a sample when p99 event-loop latency reaches this level.

      # Paths & volumes (optional)
      # VOLUME_ROOT: "/mnt" # Root directory that houses all mounted volumes. App will display all directores inside this directory as volumes.
      # CONFIG_DIR: "/config" # app.db (accounts, shares, settings), logos/ and session-secret — the folder to back up.
      # CACHE_DIR: "/cache" # Thumbnails, RAW previews, sessions, index.db (search index and folder sizes), uploads in progress.
      # USER_ROOT: "/mnt/_users" # Root directory for per-user personal folders (defaults to `<VOLUME_ROOT>/_users` when unset). Make sure you persist this path if you use USER_DIR_ENABLED.

      # Authentication (optional)
      # AUTH_MODE: "both" # `local|oidc|both|disabled` what authentication methods you want to enable.
      # AUTH_ENABLED: "true" # Deprecated: use `AUTH_MODE=disabled` to skip login.
      # SESSION_SECRET: "please-change-me" # Session cookie secret (alias: `AUTH_SESSION_SECRET`); when unset, one is generated once and kept in /config/session-secret. Set a long random value (>= 32 chars) to choose it, or for replicas.
      # AUTH_MAX_FAILED: "5" # Failed login attempts before temporary lockout.
      # AUTH_LOCK_MINUTES: "15" # Lockout duration (minutes) when max failures reached.
      # AUTH_ADMIN_EMAIL: "" # First-run bootstrap (local auth): when set with `AUTH_ADMIN_PASSWORD`, creates an admin user on startup and skips setup.
      # AUTH_ADMIN_PASSWORD: "" # Password for `AUTH_ADMIN_EMAIL` bootstrap; overrides/resets password on startup if the user already exists.

      # OIDC & SSO (optional)
      # OIDC_ENABLED: "false" # Enable Express OpenID Connect auth flow.
      # OIDC_ISSUER: "https://auth.example.com/application/o/next/" # IdP issuer URL (discovery).
      # OIDC_AUTHORIZATION_URL: "" # Optional discovery override.
      # OIDC_TOKEN_URL: "" # Optional discovery override.
      # OIDC_USERINFO_URL: "" # Optional discovery override.
      # OIDC_CLIENT_ID: "nextexplorer" # IdP client ID.
      # OIDC_CLIENT_SECRET: "" # IdP client secret.
      # OIDC_CALLBACK_URL: "http://localhost:3000/callback" # Explicit canonical callback URL (defaults to `${PUBLIC_URL}/callback`). When INTERNAL_URL is set, also register each internal `/callback` URL with the IdP.
      # OIDC_SCOPES: "openid profile email" # Add `groups` to propagate group claims.
      # OIDC_ADMIN_GROUPS: "" # Space/comma-separated group names that grant admin rights (matched in `groups`, `roles`, or `entitlements`).
      # OIDC_REQUIRE_EMAIL_VERIFIED: "false" # When `true`, requires IdP to verify user email before allowing user creation/auto-linking.
      # OIDC_AUTO_CREATE_USERS: "true" # When `false`, denies OIDC login unless the user already exists in the DB.

      # Feature toggles (optional)
      # SEARCH_DEEP: "false" # Enables deep content search (ripgrep used when `SEARCH_RIPGREP=true`).
      # SEARCH_RIPGREP: "true" # Prefer ripgrep for fast searches; fallback search used when unavailable.
      # SEARCH_MAX_FILESIZE: "" # Skip files larger than this when searching contents (e.g., `5MB`, `5M`).
      # SEARCH_INDEX: "false" # Answer content searches from a full-text index instead of reading the volume every time.
      # SEARCH_INDEX_CPU_PERCENT: "25" # Share of one core the background indexing pass may take.
      # SEARCH_INDEX_EXCLUDE: "" # Folders search leaves alone, comma separated, relative to the volume root.
      # SHOW_VOLUME_USAGE: "false" # Show volume usage badges in the sidebar.
      # USER_DIR_ENABLED: "false" # Enables per-user “My Files” spaces under `USER_ROOT`.
      # USER_VOLUMES: "false" # Restrict non-admin users to only volumes assigned by an admin.
      # SKIP_HOME: "false" # When `true`, `/browse/` redirects into the first volume.

      # Editor (optional)
      # EDITOR_EXTENSIONS: "" # Extra file extensions supported by the inline editor (comma-separated, added to built-in defaults).

      # OnlyOffice & thumbnails (optional)
      # ONLYOFFICE_URL: "" # Public URL for OnlyOffice Document Server (must reach your app's `PUBLIC_URL`).
      # ONLYOFFICE_SECRET: "" # JWT secret shared with OnlyOffice Document Server for `/api/onlyoffice`.
      # ONLYOFFICE_LANG: "en" # Language code for the editor UI.
      # ONLYOFFICE_FORCE_SAVE: "false" # When `true`, the OnlyOffice Save button writes the current version immediately.
      # ONLYOFFICE_AUTO_SAVE_INTERVAL_MS: "30000" # Background save cadence for changed OnlyOffice files; set `0` to save only when closing.
      # ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS: "10000" # Retry window for the background save started when closing an OnlyOffice document.
      # ONLYOFFICE_FILE_EXTENSIONS: "" # Extra file extensions to surface to the Document Server.
      # FFMPEG_PATH: "" # Point to a custom ffmpeg binary (defaults to bundled binary).
      # FFPROBE_PATH: "" # Point to a custom ffprobe binary (defaults to bundled binary).
      # THUMBNAILS_ENABLED: "true" # Set to "false" to disable thumbnail generation globally.
      # THUMBNAIL_CACHE_MAX_FILES: "3000" # Max files kept in /cache/thumbnails; set 0 to disable cleanup.
      # RAW_PREVIEW_CACHE_MAX_FILES: "500" # Max RAW previews kept in /cache/raw-previews, oldest removed first; set 0 to disable cleanup.
      # THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE: "500" # Max thumbnail cache files deleted per cleanup pass.
      # THUMBNAIL_SHARP_CACHE_MEMORY_MB: "0" # Sharp/libvips thumbnail cache memory budget.
      # THUMBNAIL_VIDEO_CONCURRENCY: "1" # Max concurrent ffmpeg thumbnail jobs.
      # THUMBNAIL_VIDEO_SEEK_SECONDS: "5" # Timestamp used for video thumbnails; avoids probing every video by default.
      # THUMBNAIL_VIDEO_SEEK_PERCENT: "" # Optional 0-1 value to seek by duration percentage; enables ffprobe per video.
      # THUMBNAIL_VIDEO_THREADS: "1" # ffmpeg thread limit for video thumbnail extraction.
      # THUMBNAIL_VIDEO_SCALE_FLAGS: "fast_bilinear" # ffmpeg scale flags; use lanczos for sharper but heavier thumbnails.
      # THUMBNAIL_BACKGROUND_QUEUE_LIMIT: "8" # Max pending/in-flight thumbnail jobs accepted before clients retry later.
      # THUMBNAIL_DIAGNOSTICS_ENABLED: "false" # Enable detailed thumbnail queue/memory/process logs.
      # THUMBNAIL_DIAGNOSTICS_INTERVAL_MS: "30000" # Interval for thumbnail diagnostics logs.
      # THUMBNAIL_SLOW_JOB_MS: "10000" # Log thumbnail jobs/processes slower than this threshold.
      # THUMBNAIL_FFMPEG_TIMEOUT_MS: "300000" # Kill one ffmpeg thumbnail run that has taken this long; the thumbnail is marked failed.

      # Container user mapping (optional)
      # PUID: "1000" # Map container processes to host UID so created files have consistent ownership.
      # PGID: "1000" # Map container processes to host GID so created files have consistent ownership.
```

</details>

## Documentation

- Quick start: https://cerede2000.github.io/NextExplorer/quick-launch/overview.html
- Visual tour: https://cerede2000.github.io/NextExplorer/quick-launch/visual-tour.html
- Feature guide: https://cerede2000.github.io/NextExplorer/experience/features.html
- Admin & access control: https://cerede2000.github.io/NextExplorer/admin/guide.html
- Deployment & reverse proxy: https://cerede2000.github.io/NextExplorer/installation/deployment.html and https://cerede2000.github.io/NextExplorer/installation/reverse-proxy.html
- Environment variables: https://cerede2000.github.io/NextExplorer/configuration/environment.html
- Runtime settings: https://cerede2000.github.io/NextExplorer/configuration/settings.html
- Integrations (OIDC, Authelia, ONLYOFFICE): https://cerede2000.github.io/NextExplorer/integrations/oidc.html
- Troubleshooting/FAQ: https://cerede2000.github.io/NextExplorer/reference/troubleshooting.html and https://cerede2000.github.io/NextExplorer/reference/faq.html
- Releases: https://cerede2000.github.io/NextExplorer/reference/releases.html
- Contributing: https://cerede2000.github.io/NextExplorer/reference/contributing.html
