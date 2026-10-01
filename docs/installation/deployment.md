# Deployment

Deploy nextExplorer via Docker Compose for reproducible self-hosted workflows. This guide outlines the folders, networking, and procedures you’ll rely on for production-ready setups.

## Prerequisites

- **Docker Engine 24+ and Docker Compose v2** (or later). The official image depends on modern orchestration features.
- **Host directories** for data volumes, `/config`, and `/cache` (make sure the Docker user can read/write these paths). `/cache` can be left out, but it holds the search index and the folder sizes: without a persistent mount, every new container reads the volumes again to rebuild them.
- **TLS-capable reverse proxy** if you need HTTPS, custom domains, or sticky sessions.

## Image contents

The published application image supports both `linux/amd64` and `linux/arm64`.
It includes a minimal software-decoding FFmpeg build and RAW-photo support.
FFmpeg is built and verified in a separate versioned image, then copied into the
application image; normal application releases do not compile it.

```text
ghcr.io/nxzai/explorer:latest
ghcr.io/nxzai/nextexplorer-ffmpeg:8.1.3
```

The FFmpeg artifact is an application build input, not a service users need to
run. Hardware acceleration requires a compatible custom FFmpeg/FFprobe pair,
the host's GPU device exposed to the container, and the matching
`FFMPEG_HWACCEL` settings.

## Host folder layout

| Purpose                       | Container path                                | Notes                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts, shares, settings    | `/config`                                     | Holds `app.db`, `logos/` and `session-secret`. The folder to back up — see [Backups](/admin/guide#backups-persistence).                                                              |
| Thumbnails, sessions, indexes | `/cache`                                      | Regenerable and needs no backup, but mount it persistently: it holds `index.db`, the search index and folder sizes, and deleting it signs everyone out and reads every volume again. |
| Browsable data                | `/mnt/Label`                                  | Each mount appears as a top-level volume with the given label.                                                                                                                       |
| Personal user data (optional) | `/srv/users` (or any path set as `USER_ROOT`) | When `USER_DIR_ENABLED=true`, each authenticated user gets their own private folder inside this root.                                                                                |

## Production compose example

```yaml
services:
  nextexplorer:
    image: ghcr.io/cerede2000/explorer:latest
    container_name: nextexplorer
    restart: unless-stopped
    ports:
      - '3000:3000'
    environment:
      - NODE_ENV=production
      - PUBLIC_URL=https://files.example.com
      - SESSION_SECRET=please-change-me
      - PUID=1000
      - PGID=1000
      # Enable per-user "My Files" home folders
      - USER_DIR_ENABLED=true
      - USER_ROOT=/srv/nextexplorer/users
    volumes:
      - /srv/nextexplorer/config:/config
      - /srv/nextexplorer/cache:/cache
      - /srv/data/Projects:/mnt/Projects
      - /srv/data/Media:/mnt/Media
      # Personal home folders (one subfolder per user)
      - /srv/nextexplorer/users:/srv/nextexplorer/users
```

- `PUBLIC_URL` informs the backend's cookie settings, CORS, and default OIDC callback (see `backend/src/config/env.js`).
- `SESSION_SECRET` sets the session secret yourself. Without it, one is generated at the first start and kept in `/config/session-secret`, so sessions survive restarts all the same; set it when several replicas share the sessions.
- Optional first-run bootstrap: set `AUTH_ADMIN_EMAIL` and `AUTH_ADMIN_PASSWORD` to auto-create the first local admin on startup (skips the setup wizard).

### Use FFmpeg binaries from the host

Settings → FFmpeg accepts paths inside the container. Docker cannot execute an
arbitrary host path until it is bind-mounted, and the binaries must match the
host CPU architecture and run on Alpine Linux. Static binaries are the safest
choice. Mount both files read-only, then save their container paths:

```yaml
services:
  nextexplorer:
    volumes:
      - /opt/ffmpeg/ffmpeg:/host-tools/ffmpeg:ro
      - /opt/ffmpeg/ffprobe:/host-tools/ffprobe:ro
```

Set **FFmpeg executable path** to `/host-tools/ffmpeg` and **FFprobe executable
path** to `/host-tools/ffprobe`. The server verifies that each path is executable
and applies the change immediately. Clearing a field returns to `FFMPEG_PATH` or
`FFPROBE_PATH`, then to the binaries bundled with the image.

## Launching and validating

1. Run `docker compose up -d` from the folder containing your Compose file.
2. Visit `http://localhost:3000` (or your `PUBLIC_URL`) and sign in (or, if you didn’t set `AUTH_ADMIN_*`, finish the setup wizard to create the first local admin).
3. Revisit Settings to adjust thumbnails, access control, and users.
4. Confirm each `Label` shows up in the sidebar and that you can browse/upload files.

## Managing updates

```bash
docker compose pull
docker compose up -d
```

- Persistent state (`app.db`, `logos/`, `session-secret`) stays inside `/config`. Back it up before upgrading, with the container stopped or together with `app.db-wal`.
- Installations that started on 1.1.7 or earlier kept `app.db` in `/cache`. Nothing moves it any more: copy it to `/config` by hand before upgrading such an installation; the server warns at start when it finds such a file there. Links named `app.db`, `app-config.json` or `extensions` left in `/cache` by 1.1.8 to 2.0.2 are unused and can be deleted.

## Monitoring & logs

- Use `LOG_LEVEL`, `DEBUG`, and `ENABLE_HTTP_LOGGING` (from `backend/src/config/env.js`) to tune logging verbosity.
- The container writes logs to stdout/stderr; stitch them together with your orchestrator (Docker logs, systemd, etc.).
