# Features

nextExplorer mixes a modern browser experience with secure access controls and filesystem workflows. Here are the standout capabilities available out of the box.

## File browsing & previews

- **Dual views:** Switch between responsive grid, list, and column modes while keeping breadcrumbs, toolbar, and search accessible.
- **Inline previews:** Images, videos, PDFs, and text files preview instantly without downloads. Image/video thumbnails are generated automatically using FFmpeg (`FFMPEG_PATH`/`FFPROBE_PATH` can override binaries).
- **Media gallery:** Pictures and videos open in one viewer and are browsed together — swipe on a touch device, arrow keys or on-screen arrows elsewhere. Pictures zoom by pinch, double-tap or ctrl-wheel; while zoomed, dragging pans the picture instead of turning the page.
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
  - Optionally **password-protected** and **time-limited** with an expiration date.
    After creation, the dialog shows a friendly label, final URL (based on `PUBLIC_URL` when set), and a one-click **Copy link** button.
- **Guest access to shares:** Public “anyone with the link” shares use short tokens (for example, `/share/aBc123XyZ`) and create a limited **guest session** so visitors can browse just the shared item. Password-protected shares prompt for the password first; user-specific shares redirect to the login screen and apply normal access checks after authentication. The password applies to everyone except the share's owner — being signed in, including as an administrator, is not the same as knowing it. This matters for shares pointing at a personal folder, which no other account can reach any other way. With `AUTH_MODE=disabled` there are no accounts to tell apart and every visitor already browses the whole filesystem, so the prompt is skipped.
- **“Shared with me” view:** The **Shares** section in the sidebar links to a **Shared with me** page showing items other people have shared with you, including status (active/expired), access mode, and last accessed time.
- **ONLYOFFICE integration:** When `ONLYOFFICE_URL` and the JWT `ONLYOFFICE_SECRET` are configured, docx/xlsx/pptx/odt/ods/odp files open for editing via `/api/onlyoffice/*`. Two people opening the same document join the same session and edit it together. The editor follows the app's theme, closes with its own button (saving on the way out), and can rename the open document, save it under a new name, share it, mention other users, compare against another version, and insert files picked from your own storage. Work is saved in the background while the document stays open.
- **New office documents:** The drawer beside **New file** creates a blank Word, Excel or PowerPoint document and opens it straight in the editor.
- **Favorites:** Pin folders to the sidebar with a star so critical paths stay in reach across sessions.

## Search & metadata

- **Smart search:** The search bar uses ripgrep under the hood (enable or disable via `SEARCH_RIPGREP`, `SEARCH_DEEP`, and `SEARCH_MAX_FILESIZE`) to find filenames and contents inside the current folder and its children.
- **Metadata overlays:** List view shows size, kind, modified date, owner, and volume stats (volume usage visibility flips on with `SHOW_VOLUME_USAGE`).
- **Thumbnail cache:** `/cache` holds thumbnails and search indexes that regenerate when cleared.

## Access & security

- **Local users & groups:** Create local accounts from Settings → Admin; the first account becomes admin and can’t be removed while others exist.
- **OIDC SSO:** Express OpenID Connect exposes `/login`, `/logout`, and `/callback`, so you can federate with Keycloak, Authentik, Authelia, or any compliant provider. Admin elevation happens when the IdP groups/roles intersect `OIDC_ADMIN_GROUPS`.
- **Per-user access control:** Grant or deny paths per user or group, with read, write and delete kept apart. Personal folders (`USER_DIR_ENABLED`) and per-user volumes build on the same rules.
- **Secrets from files:** Every credential can be read from a file instead of the environment, so nothing sensitive appears in `docker inspect`. See [Secrets](/configuration/environment#secrets).
- **Workspace lock:** A workspace password (set on first run) gates access, and admin-only sections (Files & Thumbnails, Security, Access Control, Admin Users) appear only when your role allows it.

## Operational helpers

- **Resizeable sidebar:** The sidebar can be dragged to different widths for wide or narrow monitors.
- **Notifications & transfers:** A floating panel tracks uploads, copies, moves and archive work, with pause, resume and cancel, the transfer rate, and per-file detail when several run at once.
- **Chunked uploads:** Large files can be uploaded in resumable chunks (`UPLOAD_CHUNKED_ENABLED`), which survives a dropped connection and gets past reverse proxies that refuse large bodies — a fallback switches to chunks automatically when one does. Once the transfer ends, the server may still be writing the file into place; that phase is reported separately rather than appearing to stall at 100%.
- **Cancellable file operations:** Copy and move run natively with real progress and can be stopped mid-way, leaving nothing half-written.
- **Keyboard shortcuts:** ⌘/Ctrl+C/X/V for clipboard actions, plus quick navigation via breadcrumbs and toolbar icons.
