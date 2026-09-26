# Runtime Settings

In-app settings expose many server-side toggles you'll also find in the environment reference. Admin sections unlock once your user has the `admin` role or matches `OIDC_ADMIN_GROUPS`.

## Branding

Customize the appearance and branding of your nextExplorer instance:

- **Application name:** Display a custom name in the header, login page, and browser title (e.g., "SPRINTR" instead of "Explorer").
- **Logo upload:** Upload a custom logo (SVG, PNG, or JPG; max 2MB). Perfect size is 200×200px. Displays in the header and login page.
- **Attribution link:** Toggle the optional "Powered by nextExplorer" footer link. When enabled, users see a link crediting the original project.

## Files & Thumbnails

- **Enable thumbnails:** Toggle thumbnail generation (uses Sharp/FFmpeg). Disable to reduce CPU usage when browsing large volumes.
- **Thumbnail quality:** 1–100 (default 70) to control JPEG compression level.
- **Max dimension:** Longest side in pixels (default 200) for generated thumbnails.
- **Video previews:** Require FFmpeg/ffprobe; binaries are included but you can override paths via environment variables.

## Security & Authentication

- **Authentication toggle:** Turn on/off authentication for trusted, internal networks (not recommended for public deployments).
- **OIDC configuration:** The fields here mirror the environment variables in the reference section. Use them to enable SSO once you’ve configured your IdP.
- **Session locking:** Enable/disable workspace password prompts that gate the entire UI.

## Access Control

- **Rule editor:** Define per-folder rules with `path`, `type` (`rw`, `ro`, `hidden`), and recursion options.
- **First-match wins:** Rules are evaluated top to bottom; the first matching path governs browser behavior. A rule that does not hold the account asking is passed over rather than matched, so a later rule still gets its say.
- **Who a rule restricts:** every rule restricts every ordinary account. Whether it also restricts administrators is the rule's own switch, **Applies to administrators**, the same whatever the rule grants — so a `ro` rule can hold them to reading, and a `hidden` rule can leave a folder in plain sight for them while hiding it from everybody else.
- **Apply every rule to administrators:** one switch above the list. With it on, no rule lets an administrator through and each rule's own box is ignored; with it off, each rule decides for itself.
- **Rules written before this existed** keep doing what they did — a `ro` rule left administrators free to write, a `hidden` rule hid the folder from them too — until the box on the rule is changed. Nothing moves on an upgrade.
- **Hidden folders:** `hidden` keeps a folder out of listings and search, and refuses it by its address as well.

## Activity log

- **Off unless you ask for it.** On a machine one person uses, a record of what that person did all day is weight with no reader; on a server several people share, it is the first thing anybody asks for the day a file is gone. So it is a switch, under **Settings → Activity log**, and nothing is written until it is on.
- **What it writes down:** sign-ins, including the ones that were refused and the name that was tried, and sign-outs; files downloaded, uploaded, sent to the trash, restored and removed for good; earlier versions of a file removed, whether from the panel or with the file itself; what left through a share link and what arrived through one; shares created and deleted; account changes, whether somebody's own (password, second factor, passkey) or an administrator's; and which settings were changed — the sections, not the values.
- **Each line carries** who, what, when, what it was about, whether it worked, and the address the request came from. Behind a reverse proxy, or in a container reached from its own host, that address is only the person's if `TRUST_PROXY` says the proxy may be believed; **Settings → Activity log** says which address this server would record and why.
- **Only administrators read it**, and an administrator can empty it. The line saying they did is written after the deletion, so it is the one that survives it.
- **How long a line is kept** is the retention, swept hourly whether the log is on or off: switching it off lets the disk go back rather than freezing what was written the day before.

## Admin Users

- **Create or edit local users:** Manage usernames, passwords, and roles (user vs admin).
- **Password reset:** Reset passwords for local accounts without needing direct OS access.
- **Admin safeguarding:** The UI prevents demoting or deleting the last admin to avoid lockouts.

## Additional hints

- Most settings persist in `/config/app-config.json`. Back up `/config` before making sweeping changes.
- Favorites and access control settings sync with the sidebar, so once you pin a favorite it surfaces immediately for all sessions.
