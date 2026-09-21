# Runtime Settings

In-app settings expose many server-side toggles you'll also find in the environment reference. Admin sections unlock once your user has the `admin` role or matches `OIDC_ADMIN_GROUPS`.

## Branding

Customize the appearance and branding of your nextExplorer instance:

- **Application name:** Display a custom name in the header, login page, and browser title (e.g., "SPRINTR" instead of "Explorer"). It cannot be empty: the page refuses to save a name of nothing or of spaces, and the server keeps the stored name when sent one.
- **Logo upload:** Upload a custom logo (SVG, PNG, or JPG; max 2MB). Perfect size is 200×200px. Displays in the header and login page. A chosen logo is only previewed on the page: nothing is sent until **Save**, which stores it together with the name and the attribution link, or nothing at all, and **Discard** brings back the logo in use. Each logo is written to `/config/logos` under a name of its own, so its address changes and no browser keeps showing the previous one; the logo it replaced is removed once the new one is in place.
- **Attribution link:** Toggle the optional "Powered by nextExplorer" footer link. When enabled, users see a link crediting the original project.

## Files & Thumbnails

- **Enable thumbnails:** Toggle thumbnail generation (uses Sharp/FFmpeg). Disable to reduce CPU usage when browsing large volumes.
- **Thumbnail quality:** 1–100 (default 70) to control JPEG compression level.
- **Max dimension:** Longest side in pixels, 64–1024 (default 200), for generated thumbnails.
- **Parallel generation:** How many thumbnails are made at once, 1–50 (default 10).
- A value outside these bounds, or an emptied field, is shown as invalid and cannot be saved.
- **Video previews:** Require FFmpeg/ffprobe; binaries are included but you can override paths via environment variables.

## Search index

- **Keep a search index:** Reads the volume in the background — the name of every file and folder, and the words inside documents — so that a search answers from the index instead of walking the storage. It starts or stops as soon as the switch moves, and the choice survives a restart.
- **Exclusions:** Folders the index and a name search leave alone. Those set by `SEARCH_INDEX_EXCLUDE` are listed and cannot be removed here; the second list is yours to edit. A folder added here is forgotten by the index straight away, in batches that leave the server answering meanwhile.
- **The environment decides when it speaks:** with `SEARCH_INDEX` set, the page shows the value in force, names the variable, and the switch cannot move it. Left unset, the switch decides — so an installation configured by file behaves as it always did.

## Folder sizes

- **Measure folder sizes:** _Off_, _Their own files only_, or _Everything inside them_. Changing between the two measuring modes measures again from scratch.
- **Exclusions:** as for the search index — the ones from `FOLDER_SIZE_EXCLUDE_PATHS` are fixed, the second list is editable.
- **The environment decides when it speaks:** `FOLDER_SIZE_MODE`, set, holds the switch the same way.

These two are the only background workers a page can start. Both read volumes the server already reads and grant nothing over the host; the terminal, the paths, the secrets, proxy trust and whether non-administrators see every volume stay in the environment, because they widen what an administrator's session can do — and a stolen one should not be able to widen them.

## About

- **Version, commit and branch** of the build that is running.
- **Optional tools** _(administrators only)_: ffmpeg, ffprobe, ripgrep, pdftotext, ExifTool, rsync and 7-Zip, and for each one:
  - whether this instance has it, and the version it reports. The version is asked of the very binary the application runs, and left out rather than guessed when the tool's answer does not state one;
  - what it gives, and for a missing one the package that brings it back, which is not always the tool's own name;
  - for 7-Zip, the formats it cannot open here.

  The server writes the same list, versions included, to its log at every start.

## Security & Authentication

- **Authentication toggle:** Turn on/off authentication for trusted, internal networks (not recommended for public deployments).
- **OIDC configuration:** The fields here mirror the environment variables in the reference section. Use them to enable SSO once you’ve configured your IdP.
- **Session locking:** Enable/disable workspace password prompts that gate the entire UI.

## Access Control

- **Rule editor:** Define per-folder rules with `path`, `type` (`rw`, `ro`, `hidden`), and recursion options.
- **First-match wins:** Rules are evaluated top to bottom; the first matching path governs browser behavior.
- **Hidden folders:** Use `hidden` to keep folders out of listings while still accessible via direct URLs.

## Admin Users

- **Create or edit local users:** Manage usernames, passwords, and roles (user vs admin).
- **Password reset:** Reset passwords for local accounts without needing direct OS access.
- **Admin safeguarding:** The UI prevents demoting or deleting the last admin to avoid lockouts.

## Additional hints

- Settings persist in `app.db` under `/config`, and the logo uploaded in Branding in `/config/logos`. Back up `/config` before making sweeping changes.
- Favorites and access control settings sync with the sidebar, so once you pin a favorite it surfaces immediately for all sessions.
