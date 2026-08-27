# ONLYOFFICE Integration

Use ONLYOFFICE Document Server to edit office files (DOCX, XLSX, PPTX, ODT, ODS, ODP) from within nextExplorer. The integration relies on server-to-server API calls and a shared JWT secret.

## Environment variables

| Variable                           | Required?            | Description                                                                                                                                         |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ONLYOFFICE_URL`                   | Yes                  | Public URL of your Document Server (e.g., `https://office.example.com`).                                                                            |
| `PUBLIC_URL`                       | Yes                  | nextExplorer’s public URL so ONLYOFFICE knows where to download files and post callbacks.                                                           |
| `ONLYOFFICE_SECRET`                | Yes                  | JWT secret shared between nextExplorer and ONLYOFFICE for signing requests/responses.                                                               |
| `ONLYOFFICE_LANG`                  | No (default `en`)    | Language code for the editor UI.                                                                                                                    |
| `ONLYOFFICE_FORCE_SAVE`            | No                   | When true, the editor Save button immediately writes the current version through the callback.                                                      |
| `ONLYOFFICE_AUTO_SAVE_INTERVAL_MS` | No (default `30000`) | Minimum delay between background force-saves of a changed document. Set `0` to save only on close. Values are clamped between `0` and `300000`.     |
| `ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS` | No (default `10000`) | Retry window in milliseconds for a force-save when Document Server is still receiving the final changes. Minimum `7000`; closing remains immediate. |
| `ONLYOFFICE_FILE_EXTENSIONS`       | No                   | Comma-separated list of extensions you want to surface beyond the defaults.                                                                         |

## How it works

During editing, ONLYOFFICE synchronizes changes with its Document Server first.
That internal synchronization does not rewrite the source file mounted in
NextExplorer on every keystroke. The source file is replaced only when
Document Server calls the storage callback: normally after the last editor
closes, or after a force-save. NextExplorer schedules a bounded force-save
after ONLYOFFICE confirms it has received changes, then retries briefly if the
final changes are still arriving. This keeps a usable current version on the
mounted storage while avoiding a full document conversion for every keystroke.
The replacement remains atomic: the existing document is kept if the updated
version cannot be downloaded completely.

1. Opening a compatible file triggers a call to `/api/onlyoffice/config`, which returns editor configuration and a signed `config.token` when `ONLYOFFICE_SECRET` is set.
2. ONLYOFFICE fetches the file through `/api/onlyoffice/file?path=...` with an `Authorization: Bearer <config.token>` header.
3. When ONLYOFFICE has delivered changes to Document Server, nextExplorer asks it to force-save at most once per `ONLYOFFICE_AUTO_SAVE_INTERVAL_MS`. When the preview closes, nextExplorer waits only for its own API to accept a final request, never for the longer document conversion and callback. The normal delayed close callback remains a fallback.

## Editing activity and co-editing

NextExplorer shows a pencil indicator beside a document when it is open in ONLYOFFICE. The state is deliberately advisory: it is not a filesystem lock. Copying, moving, renaming, or deleting an active document remains possible, but the explorer displays a warning before the operation continues.

The indicator uses the local editor session and ONLYOFFICE callback status updates. It expires automatically when a browser or Document Server disappears, so stale state can never block work.

Co-editing is native to ONLYOFFICE. Two people simply open the same file through NextExplorer with write permission; ONLYOFFICE recognizes the shared document key and opens its normal collaborative session. No separate co-edit link, shared session, or additional NextExplorer setting is required.

The document key is what decides this, and it stays stable for as long as anyone has the document open — two different keys would be two independent sessions on one file, invisible to each other, where whoever saved last would overwrite the other. The key changes once the document is released, so a later reader is served the saved file rather than a cached copy. A document renamed from the editor keeps its session, and anyone opening it under the new name joins the one already running.

## What the editor can do

Beyond editing, the toolbar reaches back into NextExplorer:

- **Close**, drawn by the Document Server itself, which force-saves on the way out rather than leaving the last changes to a delayed callback.
- **Rename** the open document, and **Save as** under a new name — both keep the running session, so co-editors are not dropped.
- **Share** the document without leaving it, through the usual share dialog.
- **Mentions**: typing `@` in a comment offers the users who can already reach the document.
- **Compare** against another document, and **insert** an image, spreadsheet or presentation picked from your own storage. Each is handed to the Document Server as a short-lived read-only URL for that one file.
- The editor follows the app's light or dark theme, and reloads the document when it has moved on.

**New file** offers blank Word, Excel and PowerPoint documents from a drawer beside it; the new document opens straight in the editor.

## Security notes

- Tokens are signed with HS256 using `ONLYOFFICE_SECRET`. Keep this secret in sync with the Document Server’s `services.CoAuthoring.secret` (`local.json`). It can be supplied as `ONLYOFFICE_SECRET_FILE` instead, which keeps it out of `docker inspect` — see [Secrets](/configuration/environment#secrets).
- To inspect the secret, run inside the Document Server container:
  ```bash
  jq -r '.services.CoAuthoring.secret.session.string' /etc/onlyoffice/documentserver/local.json
  ```
- Disable ONLYOFFICE JWT on the Document Server only if you completely trust the network; otherwise, mismatched tokens result in “document security token is not correctly configured.”
