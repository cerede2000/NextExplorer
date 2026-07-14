# ONLYOFFICE Integration

Use ONLYOFFICE Document Server to edit office files (DOCX, XLSX, PPTX, ODT, ODS, ODP) from within nextExplorer. The integration relies on server-to-server API calls and a shared JWT secret.

## Environment variables

| Variable                     | Required?         | Description                                                                               |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `ONLYOFFICE_URL`             | Yes               | Public URL of your Document Server (e.g., `https://office.example.com`).                  |
| `PUBLIC_URL`                 | Yes               | nextExplorer’s public URL so ONLYOFFICE knows where to download files and post callbacks. |
| `ONLYOFFICE_SECRET`          | Yes               | JWT secret shared between nextExplorer and ONLYOFFICE for signing requests/responses.     |
| `ONLYOFFICE_LANG`            | No (default `en`) | Language code for the editor UI.                                                          |
| `ONLYOFFICE_FORCE_SAVE`      | No                | When true, the editor Save button immediately writes the current version through the callback. |
| `ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS` | No (default `10000`) | Retry window in milliseconds for the background save started when closing the editor. Minimum `7000`; closing remains immediate. |
| `ONLYOFFICE_FILE_EXTENSIONS` | No                | Comma-separated list of extensions you want to surface beyond the defaults.               |

## How it works

During editing, ONLYOFFICE synchronizes changes with its Document Server first.
That internal synchronization does not rewrite the source file mounted in
NextExplorer on every keystroke. The source file is replaced only when
Document Server calls the storage callback: normally after the last editor
closes, or immediately after a force-save. NextExplorer queues a force-save in
the background when its editor closes, retries briefly if the final changes are
still arriving, and atomically replaces the source file only after the full
updated document has been downloaded.

1. Opening a compatible file triggers a call to `/api/onlyoffice/config`, which returns editor configuration and a signed `config.token` when `ONLYOFFICE_SECRET` is set.
2. ONLYOFFICE fetches the file through `/api/onlyoffice/file?path=...` with an `Authorization: Bearer <config.token>` header.
3. When the preview closes, nextExplorer waits briefly for the editor to transmit pending changes, asks Document Server to force-save the current version, and waits for the authorized `/api/onlyoffice/callback?path=...` response to write the file. Its normal delayed close callback remains a fallback when the accelerated save cannot complete.

## Security notes

- Tokens are signed with HS256 using `ONLYOFFICE_SECRET`. Keep this secret in sync with the Document Server’s `services.CoAuthoring.secret` (`local.json`).
- To inspect the secret, run inside the Document Server container:
  ```bash
  jq -r '.services.CoAuthoring.secret.session.string' /etc/onlyoffice/documentserver/local.json
  ```
- Disable ONLYOFFICE JWT on the Document Server only if you completely trust the network; otherwise, mismatched tokens result in “document security token is not correctly configured.”
