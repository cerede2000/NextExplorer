# Features

nextExplorer mixes a modern browser experience with secure access controls and filesystem workflows. Here are the standout capabilities available out of the box.

## File browsing & previews

- **Dual views:** Switch between responsive grid, list, and column modes while keeping breadcrumbs, toolbar, and search accessible.
- **Inline previews:** Images, videos, PDFs, and text files preview instantly without downloads. Image/video thumbnails are generated automatically using FFmpeg (`FFMPEG_PATH`/`FFPROBE_PATH` can override binaries).
- **Media gallery:** Pictures and videos open in one viewer and are browsed together — swipe on a touch device, arrow keys or on-screen arrows elsewhere. Pictures zoom by pinch, double-tap or ctrl-wheel; while zoomed, dragging pans the picture instead of turning the page.
- **Subtitles:** A video offers the subtitle tracks inside it and any subtitle files sitting beside it — `film.srt`, `film.fr.srt`, `film.en.forced.srt` — converted to WebVTT and listed in the browser's own captions menu. Blu-ray and DVD subtitles are pictures of words rather than text, so they are not offered; turning those into captions would need OCR.
- **Why a video is silent:** Playback hands the file to the browser and never transcodes — that is a media server's job, not a file explorer's. The consequence used to be invisible: a film whose soundtrack is AC-3, E-AC-3, DTS or TrueHD plays perfectly with no sound in Chrome or Firefox, because those browsers will not decode them. The player now says so, naming the codec, and says the same when the picture itself is one the browser cannot decode — HEVC, most often. Switching between audio tracks appears only in browsers that support it, which today means Safari.

- **Drag-to-move (desktop):** Select one or more items, then drag them onto a destination folder to move them. Hold Alt (Option on macOS) to copy instead, and drop onto a favorite in the sidebar to send items there without navigating.
- **Move to / Copy to:** From the context menu, pick a destination from a dialog that offers your recent destinations and favorites before any browsing. This is the way to move files on a touch device, where dragging is unavailable.
- **Drag-to-upload:** Drop files or folders from your device onto the main pane to upload them.
- **Mobile selection mode:** On touch devices, use **Select** to enable checkbox selection for batch actions.
- **Context menus:** Right-click the background or individual items for quick shortcuts (New Folder/File, Paste, Move to, Rename, Get Info, download, delete).
- **Quick actions:** An optional inline menu puts the actions you choose on each row, without opening the context menu. Off by default; configure it in Settings → User preferences.
- **Per-folder sorting:** A folder reopens sorted the way you left it.
- **Folder sizes:** With `FOLDER_SIZE_MODE`, folders show their recursive size, computed in the background and kept up to date as files move.
- **Keyboard navigation:** Move through a folder with the up and down arrows, open with Enter or the right arrow, and go up a level with Backspace or the left arrow.

## Editing, sharing & document workflows

- **Built-in editor:** Double-click any text or code file to edit it inline with syntax highlighting, line numbers, and Save/Cancel actions. Supports 50+ file types by default (txt, md, json, js, ts, py, yml, html, css, and many more). Extend support for additional formats at runtime using the `EDITOR_EXTENSIONS` environment variable—no rebuild required.
- **Link-based sharing:** Use the **Share** button in the toolbar to create share links for any folder or file you can access (including items under **My Files** when personal folders are enabled). Shares can be:
  - **Read-only** or **read/write**.
  - **Anyone with the link** or **specific users**.
  - **Downloadable, or read-only in the stricter sense.** Turning downloads off leaves the share readable while withholding the file itself — the download button is gone and the endpoint refuses. It is deliberately independent of read/write, because "collaborate on this, but do not take a copy home" is a coherent thing to ask for. Shares created before this existed, and any share where it is not set, allow downloads.
  - Optionally **password-protected** and **time-limited** with an expiration date.
    After creation, the dialog shows a friendly label, final URL (based on `PUBLIC_URL` when set), and a one-click **Copy link** button.
- **Guest access to shares:** Public “anyone with the link” shares use short tokens (for example, `/share/aBc123XyZ`) and create a limited **guest session** so visitors can browse just the shared item. Password-protected shares prompt for the password first; user-specific shares redirect to the login screen and apply normal access checks after authentication. The password applies to everyone except the share's owner — being signed in, including as an administrator, is not the same as knowing it. This matters for shares pointing at a personal folder, which no other account can reach any other way. With `AUTH_MODE=disabled` there are no accounts to tell apart and every visitor already browses the whole filesystem, so the prompt is skipped.
- **“Shared with me” view:** The **Shares** section in the sidebar links to a **Shared with me** page showing items other people have shared with you, including status (active/expired), access mode, and last accessed time.
- **ONLYOFFICE integration:** When `ONLYOFFICE_URL` and the JWT `ONLYOFFICE_SECRET` are configured, docx/xlsx/pptx/odt/ods/odp files open for editing via `/api/onlyoffice/*`. Two people opening the same document join the same session and edit it together. The editor follows the app's theme, closes with its own button (saving on the way out), and can rename the open document, save it under a new name, share it, mention other users, compare against another version, and insert files picked from your own storage. Work is saved in the background while the document stays open.
- **New office documents:** The drawer beside **New file** creates a blank Word, Excel or PowerPoint document and opens it straight in the editor.
- **Favorites:** Pin folders to the sidebar with a star so critical paths stay in reach across sessions.

## Search & metadata

- **Smart search:** The search bar uses ripgrep under the hood (enable or disable via `SEARCH_RIPGREP`, `SEARCH_DEEP`, and `SEARCH_MAX_FILESIZE`) to find filenames and contents inside the current folder and its children.
- **Filename patterns:** `*` and `?` in a search term match filenames rather than text — `*.ps1` finds the scripts, `conf?g.json` finds either spelling, and `Stacks/*/logs/*.log` reaches across folders. A pattern names a shape, so nothing is read inside files for it, which is also what makes it immediate.
- **Inside documents:** Word, Excel and PowerPoint files are archives of XML and PDFs keep their words in compressed streams, so a plain content search finds nothing in either. Their text is read and searched — including a word an author emphasised halfway through, which Word stores in pieces. A scanned PDF is a picture of a page and stays unsearchable: that would need OCR.
- **Metadata overlays:** List view shows size, kind, modified date, owner, and volume stats (volume usage visibility flips on with `SHOW_VOLUME_USAGE`).
- **Thumbnail cache:** `/cache` holds thumbnails, RAW previews and search indexes that regenerate when cleared; thumbnails and previews are kept within their limits (`THUMBNAIL_CACHE_MAX_FILES`, `RAW_PREVIEW_CACHE_MAX_FILES`).

## Access & security

- **Local users & groups:** Create local accounts from Settings → Admin; the first account becomes admin and can’t be removed while others exist.
- **Passkeys:** Any local account can add one in Settings → Passkeys, and sign in with a fingerprint, a face or the device's PIN instead of a password. The key stays on the device and what it signs names this site, so it cannot be phished, watched or replayed. A passkey that was unlocked to be used answers the second factor as well; one that was not still asks for the code. Browsers only allow this on a secure page served from a hostname, which the page says when it cannot be offered.
- **Two-factor authentication:** Any local account can turn on a second factor in Settings → Two-factor — a QR code for any authenticator app, a code to confirm the phone kept the secret, and ten recovery codes shown once. Signing in then asks for a code after the password; six digits are worth one sign-in, and a recovery code one use. With OIDC the second factor is the provider's.
- **OIDC SSO:** Express OpenID Connect exposes `/login`, `/logout`, and `/callback`, so you can federate with Keycloak, Authentik, Authelia, or any compliant provider. Admin elevation happens when the IdP groups/roles intersect `OIDC_ADMIN_GROUPS`.
- **Per-user access control:** Grant or deny paths per user or group, with read, write and delete kept apart. Personal folders (`USER_DIR_ENABLED`) and per-user volumes build on the same rules.
- **Secrets from files:** Every credential can be read from a file instead of the environment, so nothing sensitive appears in `docker inspect`. See [Secrets](/configuration/environment#secrets).
- **Workspace lock:** A workspace password (set on first run) gates access, and admin-only sections (Files & Thumbnails, Security, Access Control, Admin Users) appear only when your role allows it.

## Operational helpers

- **Resizeable sidebar:** The sidebar can be dragged to different widths for wide or narrow monitors.
- **Notifications & transfers:** A floating panel tracks uploads, copies, moves and archive work, with pause, resume and cancel, the transfer rate, and per-file detail when several run at once.
- **Chunked uploads:** Large files can be uploaded in resumable chunks (`UPLOAD_CHUNKED_ENABLED`), which survives a dropped connection and gets past reverse proxies that refuse large bodies — a fallback switches to chunks automatically when one does. Once the transfer ends, the server may still be writing the file into place; that phase is reported separately rather than appearing to stall at 100%, and a file that arrived but could not be put in its folder is reported as a failure, with the reason, never as done.
- **Cancellable file operations:** Copy and move run natively with real progress and can be stopped mid-way, leaving nothing half-written.
- **Nothing is ever replaced:** A copy, a move, an upload, an extraction, a new archive, a new folder, a Save as, a copy of a version or a restore from the trash takes the name it asks for only when nothing holds it — even something that arrives while it runs — and otherwise takes “name (1)”, or “name 2” for a new folder. It never replaces a file and never pours into a folder that is already there, and undoing one that failed removes only what it wrote itself: a file someone saved in the meantime stays.
- **Keyboard shortcuts:** ⌘/Ctrl+C/X/V for clipboard actions, plus quick navigation via breadcrumbs and toolbar icons.

- **Activity log:** Off unless an administrator turns it on, in Settings → Activity log. On, it writes down who signed in — including who tried and failed — what was downloaded, uploaded, deleted, restored and removed for good, what left through which share link and what arrived through one, every change to a password, a second factor or a passkey, and every account or setting an administrator changed. Administrators read it, and it keeps each line for as long as the retention says.

## How it compares

Two projects solve the same problem from a different angle:
[FileBrowser Quantum](https://github.com/gtsteffaniak/filebrowser), the active
fork of File Browser, and [Filestash](https://www.filestash.app/), which speaks
every storage protocol there is. Every cell below was read on **16 September
2026** from the project it describes — its repository, its documentation, its
pricing page — rather than from anybody's marketing or anybody's comparison
chart. The sources are listed underneath, including the ones about NextExplorer.

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
| API tokens for scripts              | 🚧                          | ✅                      | ✅                    |
| Activity log                        | ✅ optional, off by default | ✅                      | 💰                    |
| Space quotas                        | 🚧                          | 🚧                      | 💰                    |
| Terminal in the browser             | ✅ switchable               | ❌ removed deliberately | ❌                    |

### Where each answer comes from

- **NextExplorer**: the pages on this site — [archives](/experience/workflows),
  [trash](/admin/trash), [file versions](/admin/versions),
  [search](/experience/features), [two-factor, passkeys and
  access](/admin/guide) — and the suites in the repository. The 🚧 are recorded
  in `TODO.md` with what each would take; they are intentions, not dates. The ❌
  are honest: there is no LDAP here, and the two marked _by choice_ are settled
  positions rather than a backlog nobody got to.
- **FileBrowser Quantum**: its [README](https://github.com/gtsteffaniak/filebrowser)
  states OIDC, LDAP, JWT, password + 2FA and proxy sign-in, WebDAV, folder
  sizes, API tokens, granular permissions, share expiry and permissions, and
  that shell commands were removed on purpose. Its own comparison chart is
  where trash, quotas and browsing archives are marked as coming, and
  content-aware search as absent. In its source: chunked uploads, TOTP,
  WebAuthn passkeys, rate limiting on the auth routes, archive creation as zip
  or tar.gz, and twenty-six interface languages — and no extraction from an
  archive, and nothing about versioning.
- **Filestash**: its [pricing page](https://www.filestash.app/pricing/) is
  where free ends and paid begins — the self-hosted Hobby edition is AGPL and
  free, Pro starts at $50/month, Enterprise at $290/month. In its own feature
  table, OIDC, SAML, LDAP sign-on, MFA, RBAC and versioning are Enterprise;
  quotas and the audit journal are Pro; resumable uploads, shared links, the
  editors and Docker are free, and the Debian and RHEL installers are not. Its
  [README](https://github.com/mickael-kerjean/filestash) is the source for the
  storage protocols and the viewer plugin that opens `tar`, `tgz` and `zip`.
  Nothing in either describes a trash or an extraction.
- **The original [File Browser](https://github.com/filebrowser/filebrowser)**
  is left out: its README says it was archived on 1 September 2026, that there
  will be no further releases, and that two classes of security issue — the
  command runner, and sessions that are self-contained JWTs and therefore
  cannot be revoked — will not be fixed. Quantum is its active fork, and stands
  in the table instead.

### Installing it without Docker

That row was a cross until 3.8.0, and what turned it is
[an archive](/installation/standalone) rather than a single binary: the Node
runtime and the official 7-Zip build travel in it, an install script makes the
account, the directories and the systemd service, and the same script is the
update path. Quantum's ✅ is one static Go binary, which is a property of its
language rather than a difference in effort — Node cannot embed the three
native modules in this tree. What the request behind it asked for, which was
not being made to install Docker, is answered.

### The two intentions, and the two crosses that stay

Space quotas and API tokens are what the comparison still says is missing here,
and both are in the backlog with the shape they would take: the recursive
folder-size index already counts what a quota would hold people to, and token
minting is written and deliberately switched off. The activity log that was
here beside them is done, and off by default — see
[Admin & Access](/admin/guide).

WebDAV is a cross rather than a 🚧, and stays one. NextExplorer is a file
browser, not a server: something you open and use, not something other software
mounts. A protocol is a second permanent way in — its own way of proving who is
asking, its own locks, its own clients writing whenever they like — on top of a
filesystem this already reaches, and every rule about who may read, write or
delete a path would have to hold on that side too. What is mounted into the
container is what this browses, the way a drive is a volume in Windows Explorer:
an NFS or SMB share mounted on the host is already here, without this project
speaking a protocol of its own. Twenty-five storage protocols are a cross for
the same reason from the other end: that is Filestash's ground, and arriving
second on it would cost the thing this does well, which is knowing one
filesystem deeply.
