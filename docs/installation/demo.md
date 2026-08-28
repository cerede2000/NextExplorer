# Running a public demo

The demo runs at **https://nextexplorer-demo.onrender.com** — `demo@example.com` / `demo1234`.

A demo of a file manager is not an ordinary deployment: strangers will upload to
it, and the interesting parts of the application are exactly the ones you would
not normally expose. This describes the setup published at the address in the
README, and what makes it safe to leave open.

## The one setting that matters

The demo account is an **administrator**, so that visitors can see the settings,
access control and admin screens — otherwise half the application is invisible.
That is only acceptable because the terminal is off:

```yaml
TERMINAL_ENABLED: 'false'
```

The terminal is admin-only, and it is a shell inside the container. Left on, the
login you publish is a login to your host. Nothing else in this page matters as
much as that line.

Sharing is off too (`SHARES_ENABLED: 'false'`): a demo where anyone can mint
public links to what they upload is a file host, and it will be found and used
as one.

## No disk, on purpose

The service runs **without a persistent disk**. Everything a visitor does lives
until the next restart, and then `demo/Dockerfile` rebuilds the folders from the
content baked into the image.

That is the reset. There is no cleanup job to schedule, nothing accumulates
between restarts, and nobody can leave anything behind — which on a free plan
that sleeps after fifteen minutes means several times a day.

The demo folders are copied into `/mnt` when the image is built, not seeded by a
script at boot. A script that silently fails to run looks exactly like one that
ran and found nothing — which is what happened first, and the demo came up with
no volumes at all.

`demo/Dockerfile` also has to `chown` `/mnt`: the image's entrypoint takes
ownership of `/config` and `/cache` but deliberately leaves the volume root
alone, because in a real deployment that is the host's filesystem. Without it,
the demo is read-only, and uploading and renaming — most of what it exists to
show — do not work.

The image also supports `DEMO_MODE=true`, which downloads a sample archive of
photos and videos at boot. The demo does not use it: the archive is 80 MB, and
on a plan that sleeps, that is most of the delay the first visitor after a nap
would feel. Turn it on if richer content matters more than a fast wake.

## Deploying on Render

The repository carries a `render.yaml`, so Render can create the service itself:

1. Sign in at [render.com](https://render.com) and connect your GitHub account.
2. **New → Blueprint**, and pick this repository. Render reads `render.yaml`.
3. Confirm. It builds `demo/Dockerfile` and starts the service.
4. The first deploy takes a few minutes; afterwards, pushes to `main` redeploy
   it automatically.

The login is `demo@example.com` / `demo1234`, created at boot by
`AUTH_ADMIN_EMAIL` and `AUTH_ADMIN_PASSWORD`. **The password must be at least
six characters**: below that the bootstrap is skipped with only a line in the
log, and the first visitor is met by the setup wizard instead of the demo.

`DEMO_MODE` does not create an account — it only downloads sample files. The
account comes from the bootstrap variables, and because the service has no disk,
it is recreated on every restart along with everything else.

The free plan gives 512 MB of RAM and sleeps after fifteen minutes without
traffic — the first visitor then waits about thirty seconds. Both are fine for a
demo, and the sleeping is what keeps it clean.

The blueprint pins the region to Frankfurt and the `latest-lean` image: hardware
video acceleration and RAW decoding are no use on an instance this size, and the
smaller image wakes faster.

## Afterwards

Put the URL and the credentials in the README, and say plainly that the data
resets — otherwise someone will store something there and be surprised.

Watch the first day. If thumbnail generation makes the instance struggle, lower
the concurrency in **Settings → Files & thumbnails**; it is a runtime setting
rather than a variable, so it survives without redeploying.
