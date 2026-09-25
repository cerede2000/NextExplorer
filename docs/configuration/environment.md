# Environment Reference

nextExplorer is configured almost entirely through environment variables. The backend (`backend/src/config/env.js`) centralizes the defaults you see here. Use this reference when you want to tune ports, paths, auth, integrations, or feature flags.

## Server & networking

| Variable                                         | Default                                         | Description                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                           | `3000`                                          | Port the Express API and frontend listen on inside the container.                                                       |
| `HTTP_TIMEOUT`                                   | `0`                                             | Node.js HTTP `requestTimeout` (ms). Use `0` to disable (avoids the Node 5-minute default that can abort large uploads). |
| `PUBLIC_URL`                                     | _none_                                          | External URL (no trailing slash). Drives cookie settings, CORS defaults, and derived callback URLs (OIDC/OnlyOffice).   |
| `INTERNAL_URL`                                   | _none_                                          | Additional origin(s) the app may also be reached from (e.g. a LAN IP for fast local uploads), comma-separated. Treated as valid (no public-URL mismatch warning) and accepted by CORS; `PUBLIC_URL` stays canonical for share links / OIDC. |
| `TRUST_PROXY`                                    | `loopback,uniquelocal` when `PUBLIC_URL` is set | Express trust proxy configuration. Accepts `false`, numbers, CIDRs, or lists.                                           |
| `CORS_ORIGIN`, `CORS_ORIGINS`, `ALLOWED_ORIGINS` | _empty_                                         | Comma-separated list of allowed CORS origins. Defaults to the `PUBLIC_URL` / `INTERNAL_URL` origins; with none of them set, no cross-origin caller is allowed (same-origin use is unaffected). `*` reflects any origin. |

## Logging & debugging

| Variable              | Default                               | Description                                                                                                                     |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`           | `info` (or `debug` when `DEBUG=true`) | Application log level: `trace`, `debug`, `info`, `warn`, or `error`.                                                            |
| `DEBUG`               | `false`                               | When `true`, forces `LOG_LEVEL=debug` and shows more verbose diagnostics (including more detailed error output in development). |
| `ENABLE_HTTP_LOGGING` | `false`                               | When `true`, enables HTTP request logging in the backend (use with centralized log collection in production).                   |

## Paths & volumes

| Variable                 | Default                           | Description                                                                                                                                      |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VOLUME_ROOT`            | `/mnt`                            | Root directory that houses all mounted volumes.                                                                                                  |
| `CONFIG_DIR`             | `/config`                         | Location for SQLite, `app-config.json`, extensions, and settings.                                                                                |
| `CACHE_DIR`              | `/cache`                          | Location for thumbnails, ripgrep indexes, and temporary data.                                                                                    |
| `USER_ROOT`              | `<VOLUME_ROOT>/_users` when unset | Root directory for **per-user personal folders**. Each authenticated user gets their own subdirectory under this path.                           |
| `USER_FOLDER_NAME_ORDER` | `id,username,email_local`         | Controls how per-user folder names are derived for personal folders (e.g. set `username,id` to reuse `/home/<username>` when `USER_ROOT=/home`). |
| `HIDDEN_FILE_PATTERNS`   | `.`                               | Comma- or space-separated hidden filename patterns used by directory listings, volume pickers, and search. Plain values are fast filename prefixes, e.g. `.,@` hides dotfiles and Synology `@...` entries. Advanced entries can use `regex:<source>` or `/source/flags`. Set to an empty value to disable pattern hiding. |

## Authentication

| Variable                                | Default                                    | Description                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ENABLED`                          | `true` (in prod)                           | Toggles authentication; disabling makes all APIs public. **Deprecated:** use `AUTH_MODE=disabled` instead.                                                                                                                                                                                                                                                            |
| `AUTH_MODE`                             | `both` (or `local` if OIDC not configured) | Controls which authentication methods are available: `local` (username/password only), `oidc` (SSO only), `both` (both methods), or `disabled` (skip login entirely, same as `AUTH_ENABLED=false`).                                                                                                                                                                   |
| `SESSION_SECRET`, `AUTH_SESSION_SECRET` | _auto-generated_                           | Cryptographic secret used by Express to sign and encrypt session cookies and related tokens. In production, set this to a long, random, **stable** value (at least 32 characters) so sessions remain valid across restarts and multiple replicas; if left unset, a new random secret is generated on each start and all users will be logged out after every restart. |
| `SESSION_MAX_AGE_DAYS`                  | `30`                                       | Duration (in days) that user sessions remain valid. Sessions persist across browser restarts and server reboots. Set to a lower value (e.g., `7`) for stricter security, or higher (e.g., `90`) for convenience. Applies to both local authentication and OIDC sessions.                                                                                              |
| `AUTH_MAX_FAILED`                       | `5`                                        | Failed login attempts before temporary lockout.                                                                                                                                                                                                                                                                                                                       |
| `AUTH_LOCK_MINUTES`                     | `15`                                       | Lockout duration in minutes when max failures reached.                                                                                                                                                                                                                                                                                                                |
| `AUTH_ADMIN_EMAIL`                      | _none_                                     | Optional first-run bootstrap for local auth: when set with `AUTH_ADMIN_PASSWORD`, the backend creates an admin user on startup (and the setup wizard is skipped).                                                                                                                                                                                                     |
| `AUTH_ADMIN_PASSWORD`                   | _none_                                     | Password used for `AUTH_ADMIN_EMAIL` bootstrap. If a user already exists with the same email, this value **overrides/resets** the local password on startup. (Minimum 6 chars; avoid leaving this set unless you want the password enforced on every restart.)                                                                                                        |

## OIDC & SSO

| Variable                                                        | Default                                           | Description                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OIDC_ENABLED`                                                  | `false`                                           | Enable Express OpenID Connect authentication flow.                                                                                                                                               |
| `OIDC_ISSUER`                                                   | _none_                                            | IdP issuer URL (discovery).                                                                                                                                                                      |
| `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL` | _none_                                            | Optional overrides for discovery endpoints.                                                                                                                                                      |
| `OIDC_LOGOUT_URL`                                               | _none_                                            | Optional custom IdP logout URL. When set, logout requests redirect to this URL with a `post_logout_redirect_uri` parameter (OIDC standard). If not set, logout only clears the local session.    |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                          | _none_                                            | IdP credentials.                                                                                                                                                                                 |
| `OIDC_CALLBACK_URL`                                             | `${PUBLIC_URL}/callback` when `PUBLIC_URL` is set | Explicit callback path; defaults to `/callback` under `PUBLIC_URL`.                                                                                                                              |
| `OIDC_SCOPES`                                                   | `openid profile email`                            | Default scopes; add `groups` to propagate group claims.                                                                                                                                          |
| `OIDC_ADMIN_GROUPS`                                             | _none_                                            | Space/comma-separated names that grant admin rights when found in `groups`, `roles`, or `entitlements`.                                                                                          |
| `OIDC_REQUIRE_EMAIL_VERIFIED`                                   | `false`                                           | When `true`, requires the IdP to verify the user's email before allowing user creation or auto-linking. Some providers like newer Authentik versions set `email_verified` to `false` by default. |
| `OIDC_AUTO_CREATE_USERS`                                        | `true`                                            | When `false`, the user must already exist in the nextExplorer database (local or previously OIDC-linked), otherwise OIDC login is denied.                                                        |
| `OIDC_MOBILE_REDIRECT_URIS`                                     | `nextexplorer://oidc-callback`                    | Comma-separated allowlist of native-app custom-scheme redirect URIs for the mobile PKCE bridge. HTTP(S) URIs are rejected; only an allowlisted URI can receive the one-time authorization code.     |

## Search

| Variable              | Default | Description |
| --------------------- | ------- | ----------- |
| `SEARCH_DEEP`         | `true`  | Enables deep content search; ripgrep is used when `SEARCH_RIPGREP` is true. |
| `SEARCH_RIPGREP`      | `true`  | Prefer ripgrep for fast searches; fallback search is used when unavailable. |
| `SEARCH_MAX_FILESIZE` | `5MB`   | Skip content search for files larger than this. Accepts a byte count or `K`, `M`, `G`, or `T` suffix. |
| `SEARCH_TIMEOUT_MS`   | `5000`  | Maximum time a live search may run before returning the results collected so far. |

## Optional content search index

The index stores file metadata and extracted search terms, not file contents. It is disabled by default; set `SEARCH_INDEX=true` to build it. The live search remains available while the index catches up.

| Variable | Default | Description |
| --- | --- | --- |
| `SEARCH_INDEX` | `false` | Enables the resumable contentless search index. |
| `SEARCH_INDEX_BATCH` | `25` | Documents committed per index transaction. |
| `SEARCH_INDEX_CPU_PERCENT` | `25` | Maximum share of one CPU core used while indexing (`1`–`100`). |
| `SEARCH_INDEX_MEMORY_MB` | `256` | Extra process-memory budget for an indexing pass when no container memory limit applies. |
| `SEARCH_INDEX_EXCLUDE` | _empty_ | Comma- or newline-separated relative paths that the index must not read. |
| `SEARCH_INDEX_REBUILD` | `false` | When `true`, clears the derived index at startup and rebuilds it. |
| `SEARCH_INDEX_RECONCILE_MS` | `3600000` | Interval for reconciling the index with filesystem changes. |

## Archives

The official image includes 7-Zip. Archive operations stream to disk, report progress, can be cancelled, and reject archives that exceed the configured extraction limits.

| Variable | Default | Description |
| --- | --- | --- |
| `ARCHIVE_EXTENSIONS` | Built-in archive list | Comma-separated extraction allowlist. Prefix with `+` to extend the built-in list instead of replacing it (for example, `+udf,squashfs`). |
| `MAX_EXTRACTED_ARCHIVE_SIZE` | `32GB` | Maximum total uncompressed size allowed during extraction. Accepts a byte count or `K`, `M`, `G`, or `T` suffix. |
| `MAX_ARCHIVE_ENTRIES` | `100000` | Maximum number of archive entries allowed during extraction. |

## Recursive folder sizes

Folder-size indexing is off by default. It calculates recursive byte totals and entry counts in the background; scans resume after interruption and use timeouts and circuit breakers to avoid overloading slow filesystems.

| Variable | Default | Description |
| --- | --- | --- |
| `FOLDER_SIZE_MODE` | `off` | `off` disables indexing; `shallow` indexes listed folders; `full` recursively indexes the available tree. |
| `FOLDER_SIZE_EXCLUDE_PATHS` | _empty_ | Comma- or newline-separated paths to omit from folder-size scans. |
| `FOLDER_SIZE_CONCURRENCY` | `6` | Maximum concurrent local filesystem operations. |
| `FOLDER_SIZE_NETWORK_CONCURRENCY` | `2` | Maximum concurrent operations on network filesystems. |
| `FOLDER_SIZE_FLUSH_MS` | `3000` | Delay before queued index updates are flushed to storage. |
| `FOLDER_SIZE_RECONCILE_MS` | `0` | Optional fixed reconciliation interval; `0` uses adaptive scheduling. |
| `FOLDER_SIZE_REBUILD` | `false` | When `true`, rebuilds the derived folder-size index at startup. |

## Upload limits

Safety ceilings rather than tuning knobs: they exist so a single request cannot fill the volume, and the defaults are high enough for normal use.

| Variable                 | Default | Description                                         |
| ------------------------ | ------- | --------------------------------------------------- |
| `MAX_DIRECT_UPLOAD_SIZE` | `64GB`  | Largest single file an upload accepts, e.g. `10GB`. |
| `MAX_FILES_PER_UPLOAD`   | `50`    | Maximum number of files in one upload request.      |

## Copying & moving

| Variable                | Default                         | Description                                                                                                                                                                                                             |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILE_TRANSFER_ENGINE`  | `native` on Linux, else `stream` | Which engine copies a folder: `native` hands the tree to `rsync`, which does the work in one process off the event loop; `stream` copies it in JavaScript. The image carries rsync; without it the JavaScript path runs anyway. |

## Feature toggles

| Variable                   | Default | Description |
| -------------------------- | ------- | ----------- |
| `SHOW_VOLUME_USAGE`        | `false` | Show volume usage badges in the sidebar. |
| `USER_DIR_ENABLED`         | `false` | When `true`, enables a protected personal **My Files** space for each authenticated user under `USER_ROOT`. |
| `USER_VOLUMES`             | `false` | When `true`, non-admin users only see volumes assigned to them by an admin. See [User volumes](/admin/user-volumes). |
| `SKIP_HOME`                | `false` | When `true`, visits to the home view (`/browse/`) automatically redirect into the first volume. |
| `TERMINAL_ENABLED`         | `true`  | Controls the admin terminal feature. When `false`, terminal routes/UI are disabled. |
| `TERMINAL_FILE_EXTENSIONS` | `sh`    | Comma-separated extensions that show the context-menu action to open a file in the admin terminal (for example `sh,bash` or `.sh,.bash`). |

The sharing system (toolbar **Share** button, guest links such as `/share/:token`, and the **Shared with me** page) works out of the box with the feature flags above. Advanced share tuning knobs are documented under **Sharing (advanced)** below.

## Editor

| Variable              | Default | Description                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EDITOR_EXTENSIONS`   | _empty_ | Comma-separated list of additional file extensions to support in the inline text editor (e.g., `toml,proto,graphql` or `.toml,.proto`). These are **added to** the built-in defaults (txt, md, json, js, ts, py, etc.), not replacing them. Changes take effect on container restart—no frontend rebuild required. |
| `EDITOR_MAX_FILESIZE` | `2M`    | Maximum file size allowed to open in the inline text editor. Accepts a byte count or a size with `K`, `M`, `G`, `T` suffix (base 1024), e.g. `512K`, `2M`, `1G`. Files larger than this will show “This file is too large to open in the text editor.”                                                             |

## OnlyOffice & thumbnails

| Variable                      | Default            | Description                                                                                                                             |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ONLYOFFICE_URL`              | _none_             | Public URL for Document Server (must reach your app's `PUBLIC_URL`).                                                                    |
| `ONLYOFFICE_SECRET`           | _none_             | JWT secret shared with OnlyOffice Document Server for `/api/onlyoffice` calls.                                                          |
| `ONLYOFFICE_DOWNLOAD_ORIGINS` | _none_             | Comma-separated extra origins a saved document may be fetched from. Set it when the Document Server reports itself under another host than `ONLYOFFICE_URL`; that one is always allowed. |
| `ONLYOFFICE_LANG`             | `en`               | Language code for the editor UI.                                                                                                        |
| `ONLYOFFICE_FORCE_SAVE`       | `false`            | When true, OnlyOffice forces users to save via the editor UI.                                                                           |
| `ONLYOFFICE_FILE_EXTENSIONS`  | _default list_     | Extra file extensions to surface to the Document Server.                                                                                |
| `FFMPEG_PATH`, `FFPROBE_PATH` | _bundled binaries_ | Point to custom ffmpeg/ffprobe if the bundle doesn't suit your needs.                                                                   |
| `FFMPEG_HWACCEL`              | _none_             | Optional ffmpeg `-hwaccel` value used for video thumbnail generation when supported by your ffmpeg build (e.g. `vaapi`, `qsv`, `cuda`). |
| `FFMPEG_HWACCEL_DEVICE`       | _none_             | Optional ffmpeg `-hwaccel_device` value used with `FFMPEG_HWACCEL` (e.g. `0` or `/dev/dri/renderD128`).                                 |

## Collabora (WOPI)

| Variable                    | Default   | Description                                                                       |
| --------------------------- | --------- | --------------------------------------------------------------------------------- |
| `COLLABORA_URL`             | _none_    | Public base URL of your Collabora CODE server (used to build the iframe URL).     |
| `COLLABORA_DISCOVERY_URL`   | _derived_ | Override for discovery. Defaults to `${COLLABORA_URL}/hosting/discovery`.         |
| `COLLABORA_SECRET`          | _none_    | JWT secret used to sign WOPI `access_token` values for `/api/collabora/wopi/*`.   |
| `COLLABORA_LANG`            | `en`      | Language code for the Collabora UI.                                               |
| `COLLABORA_FILE_EXTENSIONS` | _empty_   | Comma-separated list of extensions to expose (e.g. `doc,docx,xls,xlsx,ppt,pptx`). |

<!--
## Sharing (advanced)

These variables are available for tuning the share system. The defaults are suitable for most deployments; many are primarily useful in large or highly regulated environments.

| Variable | Default | Description |
| --- | --- | --- |
| `SHARES_ENABLED` | `true` | Master toggle for the share feature. When disabled, share-related features are considered off. |
| `SHARES_TOKEN_LENGTH` | `10` | Length of generated share tokens (affects `/share/:token` URL length). |
| `SHARES_MAX_PER_USER` | `100` | Soft cap on the number of shares a single user can create. |
| `SHARES_DEFAULT_EXPIRY_DAYS` | `30` | Default expiration (in days) used when a share is created without an explicit expiry. |
| `SHARES_GUEST_SESSION_HOURS` | `24` | Intended lifetime (in hours) for guest sessions created when visitors open “anyone with link” shares. |
| `SHARES_ALLOW_PASSWORD` | `true` | Whether password-protected shares are allowed. |
| `SHARES_ALLOW_ANONYMOUS` | `true` | Whether “anyone with the link” shares are allowed (as opposed to user-specific shares only). | -->

## Container user mapping

| Variable       | Description                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUID`, `PGID` | Map container processes to host user/group IDs so created files have consistent ownership. Defaults to `1000`. The entrypoint adjusts ownership of `/app`, `/config`, and `/cache` accordingly. |
