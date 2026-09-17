# Install without Docker

The release carries an archive for Linux that installs the application as a
systemd service. It brings its own Node runtime and its own 7-Zip, so nothing
has to be installed first and nothing is compiled.

This is the answer to [issue #9](https://github.com/cerede2000/NextExplorer/issues/9):
Docker should not be the only way in. It is not a single self-contained binary
— see [why](#why-not-one-binary) at the end — but it is one command.

## What you need

- **Linux on x86_64 or arm64**, with glibc: Debian, Ubuntu, Fedora, RHEL and
  its rebuilds, Arch, openSUSE. On Alpine or another musl system the bundled
  runtime will not start, and the script says so rather than failing later —
  use the Docker image there.
- **systemd**, for the service. Without it the unit is still written and you
  start the program however this machine starts things.
- **root**, through `sudo`.

Node.js is not in that list. The archive has it.

## Installing

Take the archive for your architecture from
[the latest release](https://github.com/cerede2000/NextExplorer/releases/latest),
check it against the checksum published beside it, and run the script inside:

```sh
tar -xzf nextexplorer-<version>-linux-x64.tar.gz
cd nextexplorer-<version>-linux-x64
sudo ./install.sh
```

It tells you what it is doing at each step: which optional tools are missing
and what each one is for, the account it makes, where the program goes, the
configuration file it writes, and the service it hands to systemd. At the end
it prints the address to open.

Nothing about it is one-way — `sudo ./install.sh --uninstall` removes the
program and the service and keeps every file of yours.

### The options it takes

|                 |                                                                          |
| --------------- | ------------------------------------------------------------------------ |
| `--port N`      | the port to listen on, first install only (default 3000)                 |
| `--volumes DIR` | where the volumes live, first install only (default `/srv/nextexplorer`) |
| `--user NAME`   | the system account to run as (default `nextexplorer`)                    |
| `--yes`         | install the missing tools without asking                                 |
| `--skip-deps`   | do not touch the package manager                                         |
| `--no-service`  | install the files and leave systemd alone                                |
| `--uninstall`   | remove the program and the service, keep the files                       |

The first three are remembered in the configuration file. Later runs read it
rather than asking again, so an update cannot quietly move your port.

## The five optional tools

Each one is a feature the application does without when it is absent, and each
is packaged everywhere, which is why they are not in the archive:

| Tool                          | Without it                                                          |
| ----------------------------- | ------------------------------------------------------------------- |
| `ffmpeg` (`ffprobe`)          | no video thumbnails, no stills from HEIC photos, no media durations |
| `ripgrep` (`rg`)              | searching inside files falls back to a slower path                  |
| `poppler-utils` (`pdftotext`) | PDFs are not read into the search index                             |
| `perl`                        | RAW photo metadata is not read                                      |
| `rsync`                       | large copies and moves lose their progress reporting                |

The script finds which are missing and offers to install them through `apt`,
`dnf`, `pacman` or `zypper`, one at a time, so a name your distribution does
not carry costs that one line and not the whole set. Install them later and
they are picked up on the next start — nothing needs reconfiguring.

7-Zip is the exception and comes with the archive: the builds Debian and Alpine
package have no RAR codec, and browsing archives is the feature that would
quietly lose a format.

## Where everything lives

|                                            |                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `/opt/nextexplorer`                        | the program, the runtime and 7-Zip — replaced wholesale on every update |
| `/etc/nextexplorer/nextexplorer.env`       | your configuration, written once and never touched again                |
| `/var/lib/nextexplorer`                    | the database, the keys, what cannot be made again — **back this up**    |
| `/var/cache/nextexplorer`                  | thumbnails and the search index; losing it costs time, not data         |
| `/srv/nextexplorer`                        | the volumes, one per folder inside it                                   |
| `/etc/systemd/system/nextexplorer.service` | the unit                                                                |
| `/usr/local/bin/nextexplorer-upgrade`      | the update command                                                      |

```sh
systemctl status nextexplorer
journalctl -u nextexplorer -f
sudo systemctl restart nextexplorer     # after editing the configuration
```

### Adding a volume

Each folder inside `VOLUME_ROOT` is a volume, the way a drive is one in a file
manager, so a share already mounted on this machine is already a volume:

```sh
sudo mkdir /srv/nextexplorer/Photos
sudo mount /dev/sdb1 /srv/nextexplorer/Photos      # or an fstab line
sudo systemctl restart nextexplorer
```

To keep files where they already are, point `VOLUME_ROOT` at them — or bind
mount them in. A volume **outside** `VOLUME_ROOT` also needs a line in the
unit, because the service may only write where the unit says:

```sh
sudo systemctl edit nextexplorer
```

```ini
[Service]
ReadWritePaths=/srv/nextexplorer /tank/media
```

A path that does not exist stops the service from starting. That is the loud
failure rather than the quiet one.

## Updating

```sh
sudo nextexplorer-upgrade
```

It reads the latest release, downloads the archive for this machine, checks it
against the checksum published beside it, and hands over to that release's own
install script. Your configuration file, your database and your files are left
alone; the program is replaced. `--check` reports what there is and changes
nothing.

Nothing updates on a timer. Updating a file server is a decision somebody
makes, not something that happens to them overnight.

Unpacking a newer archive and running `./install.sh` again does the same thing:
the script is the install and the update, and running it twice changes nothing
the second time.

## What is different from the container

- **The terminal is off.** In the image it opens a shell inside the container;
  here it would open one on this machine, as the account the service runs as.
  `TERMINAL_ENABLED=true` in the configuration if that is what you want.
- **No `PUID`/`PGID`.** systemd runs the service as the account the unit names,
  which is what those two were emulating.
- **The service may only write to its own two directories and the volumes.**
  `ProtectSystem=strict` in the unit makes the rest of the filesystem read-only
  to it.
- **Hardware video decoding needs `/dev/dri`**, which the unit leaves reachable
  on purpose. Add `PrivateDevices=true` in a drop-in if no volume needs a
  device.

## Why not one binary

The issue asked for a standalone binary, and this is an archive instead. Node's
single-executable support cannot embed a native addon, and there are three in
here — the SQLite driver, the image processor and the terminal — each with its
own shared libraries. A "single binary" would be a self-extracting archive that
unpacked them at every start and still called out to `ffmpeg`, `7z` and `rg` as
separate programs. FileBrowser Quantum ships one file because Go compiles to a
static binary with no native dependencies; that is a property of the language,
not a matter of effort.

What the request was actually about — not being made to install Docker — is
what this delivers, in one command, with the runtime included.
