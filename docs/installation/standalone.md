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

## Installing it by hand

The script is a convenience and not a requirement. It does eight things, and
here they are — nothing below differs from what it would have done. The
commands are run in CI on every release, taken from this page, so the
procedure cannot drift from the archive it describes.

Run them from inside the unpacked archive.

<!-- by-hand:start -->

**The account it will run as.** It owns nothing in the program directory: the
program belongs to root, and is read-only to the service.

```sh
sudo groupadd --system nextexplorer
sudo useradd --system --gid nextexplorer --home-dir /var/lib/nextexplorer \
  --shell /usr/sbin/nologin --comment NextExplorer nextexplorer
```

**The program**, and the directories that hold what is yours.

```sh
sudo mkdir -p /opt/nextexplorer /etc/nextexplorer
sudo cp -a app runtime bin /opt/nextexplorer/
sudo chmod -R a+rX /opt/nextexplorer

sudo install -d -o nextexplorer -g nextexplorer \
  /var/lib/nextexplorer /var/cache/nextexplorer /srv/nextexplorer
```

**The configuration.** The example in the archive is the whole of it, with four
paths to fill in. Read it afterwards: everything in it is commented, and
nothing else has to be set.

```sh
sed -e 's|@PORT@|3000|' \
    -e 's|@VOLUME_ROOT@|/srv/nextexplorer|' \
    -e 's|@CONFIG_DIR@|/var/lib/nextexplorer|' \
    -e 's|@CACHE_DIR@|/var/cache/nextexplorer|' \
    config.env.example | sudo tee /etc/nextexplorer/nextexplorer.env > /dev/null
sudo chown root:nextexplorer /etc/nextexplorer/nextexplorer.env
sudo chmod 0640 /etc/nextexplorer/nextexplorer.env
```

**The service.** Same idea: the unit in the archive with its paths filled in.

```sh
sed -e 's|@USER@|nextexplorer|g' \
    -e 's|@GROUP@|nextexplorer|g' \
    -e 's|@NODE@|/opt/nextexplorer/runtime/bin/node|g' \
    -e 's|@PROGRAM_DIR@|/opt/nextexplorer|g' \
    -e 's|@ENV_FILE@|/etc/nextexplorer/nextexplorer.env|g' \
    -e 's|@STATE_DIR@|/var/lib/nextexplorer|g' \
    -e 's|@CACHE_DIR@|/var/cache/nextexplorer|g' \
    -e 's|@VOLUME_ROOT@|/srv/nextexplorer|g' \
    nextexplorer.service.in | sudo tee /etc/systemd/system/nextexplorer.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now nextexplorer
```

<!-- by-hand:end -->

That is the installation. The optional tools below are the ninth thing, and
they can be installed at any time — including never.

### Updating by hand

Your data is in the two directories and the volumes, so an update is the
program and nothing else:

```sh
sudo systemctl stop nextexplorer
sudo rm -rf /opt/nextexplorer/app /opt/nextexplorer/runtime /opt/nextexplorer/bin
sudo cp -a app runtime bin /opt/nextexplorer/      # from the new archive
sudo chmod -R a+rX /opt/nextexplorer
sudo systemctl start nextexplorer
```

Removed rather than copied over: a file that left the release should stop being
installed. The database carries its own version and migrates itself at the
first start.

### Removing it by hand

```sh
sudo systemctl disable --now nextexplorer
sudo rm -f /etc/systemd/system/nextexplorer.service
sudo systemctl daemon-reload
sudo rm -rf /opt/nextexplorer
```

Your configuration, database and files are in `/etc/nextexplorer`,
`/var/lib/nextexplorer`, `/var/cache/nextexplorer` and the volumes, and are
still there. Remove those four yourself if you mean to.

### Without installing anything at all

To try it, or to keep the whole thing inside one folder you can delete: unpack
it anywhere and run it, with the data somewhere of your choosing.

```sh
cd nextexplorer-<version>-linux-<arch>/app
CONFIG_DIR="$HOME/nextexplorer/config" \
CACHE_DIR="$HOME/nextexplorer/cache" \
VOLUME_ROOT="$HOME/nextexplorer/volumes" \
NODE_ENV=production \
UV_THREADPOOL_SIZE=16 \
PATH="$PWD/../bin:$PATH" \
../runtime/bin/node src/server.js
```

Uninstalling is `rm -rf` on the folder you unpacked. Nothing was installed
anywhere else: no account, no unit, nothing under `/etc`.

### Using the Node you already have

The runtime travels in the archive so that nothing has to be installed first.
If you would rather keep one Node for the whole machine, delete `runtime/` —
121 MB of the 221 the archive unpacks to — and point the unit at yours:

```ini
ExecStart=/usr/bin/node src/server.js
```

One condition: **Node 24**, and the installer checks before it installs
anything. Of the three native modules in the tree, the image processor is
N-API and takes any major and the terminal carries every ABI it knows, but the
SQLite driver is a single binary: `npm ci` resolves one prebuild, for the major
that ran it, and any other refuses to load with `NODE_MODULE_VERSION` a few
seconds after the service starts.

Which major that is, is not stated here twice. The build writes it into the
archive as `NODE_MAJORS`, beside `VERSION` and `ARCH`, and the installer reads
it from there — so an archive rebuilt on another line says so by itself rather
than waiting for this page to be corrected. v3.9.3 offered 24 or 26 on the
strength of what the modules publish on npm, which is a different question from
what one archive carries, and installing it on 26 crashed at start.

Most distributions package an older one: Debian 13 has 20.19, Ubuntu 24.04 has
18.19, Fedora 42's default is 22.21 — though Fedora also carries a `nodejs24`
package, which is the one to install there. Elsewhere that means NodeSource or
the tarball from nodejs.org.

The archive's own runtime is 24, the line under long-term support until 2028.
That is what ships, and the major the archive was built on is the one an
archive without a runtime accepts from the machine.

### What else can be thrown away

|                                         |                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `runtime/`                              | 121 MB — only if you provide Node 24 yourself, as above                                    |
| `app/node_modules/exiftool-vendored.pl` | 21 MB — only if this machine has an ExifTool of its own, or you accept losing RAW metadata |
| `bin/7zz`                               | 3.6 MB — only if you set `SEVEN_ZIP_PATH` at yours                                         |

The rest is load-bearing: the image processor and its libvips are 19 MB, the
SQLite driver 12 MB, and the built interface 5 MB. Those three stay — see
[using what the machine already has](#using-what-the-machine-already-has) for
why the first two cannot come from a package manager.

### The program directory is read-only

Nothing the application writes goes into it. The database, the keys and the
sessions go to `CONFIG_DIR`, thumbnails and the search index to `CACHE_DIR`,
and files to a volume — all three set in the configuration, all three outside
the program. The layout above makes that a fact rather than an intention: the
program belongs to root, the service runs as `nextexplorer`, and the unit's
`ProtectSystem=strict` leaves the filesystem read-only to it apart from the
three paths it names.

It is checked rather than asserted. On every release the procedure on this page
is run, an account is created, a file uploaded and a thumbnail drawn — and then
a checksum of every file in the program directory is compared with the one
taken before it started.

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

The server says the same at every start: one line naming the tools it found,
and one per missing tool with what its absence costs and the package that
brings it back. A 7-Zip that cannot open a format — RAR, from Debian's `7zip` —
is said the same way. **Settings → About** shows that list to an administrator,
for whoever does not read the log.

7-Zip is the exception and comes with the archive: the builds Debian and Alpine
package have no RAR codec, and browsing archives is the feature that would
quietly lose a format.

### The archive that brings none of it

Every release also carries a second archive, `-minimal` in its name, without
the three things a distribution can provide: the Node runtime, ExifTool and
7-Zip. Measured on v3.10.0, linux-x64: **76 MB unpacked instead of 221, and 24
MB to download instead of 74**. It is for a machine that already has a Node
the installer accepts — or for packaging this for a distribution, where every
megabyte is one the package manager could have supplied.

Nothing is given up for good: `apt install libimage-exiftool-perl` brings RAW
metadata back with nothing to configure — the application looks where a
distribution puts it — and `7zip` with `SEVEN_ZIP_PATH=/usr/bin/7z` brings
archive browsing back. What this archive
leaves out is the 21 MB of Perl and the 3.6 MB of 7-Zip, not the code that runs
them — which is why those two variables have something to drive.

```sh
tar -xzf nextexplorer-<version>-linux-x64-minimal.tar.gz
cd nextexplorer-<version>-linux-x64-minimal
sudo ./install.sh --node "$(command -v node)"
```

`--node` is worth naming rather than leaving to be found: run under `sudo`,
the PATH is root's and not yours, so a Node installed through nvm or fnm for
your own account is invisible to it. Without it the script looks on PATH, and
refuses a major none of the native modules has a prebuild for — otherwise
they refuse it themselves a few seconds after the service starts, with
`NODE_MODULE_VERSION`, which is a failure nobody reads.

Everything else is the same: the same install script, the same service, the
same update command — which keeps the flavour it was installed with, so an
update does not put the runtime back.

On Debian 13, `apt install nodejs` gives 20.19 and Ubuntu 24.04 gives 18.19;
Fedora 42 carries a `nodejs24` package. Elsewhere it means NodeSource or the
tarball from nodejs.org.

### Using what the machine already has

Two of the things in the archive can come from your distribution instead, if
you would rather not carry a second copy.

**7-Zip.** `SEVEN_ZIP_PATH` names the one to run, so `bin/7zz` can be deleted
and the variable pointed at yours. Which formats can be opened is not
assumed: at startup the server asks `7z i` what that build supports and writes
the answer to its log, so a build without a codec loses that format and
nothing else. On Debian 13 the package is `7zip`, and its own description says
the unRAR code was dropped to stay within the DFSG — `7zip-rar`, in non-free,
is what puts RAR back. `unrar` is a different program and is not used here.

**ExifTool.** Install the one your distribution packages — `libimage-exiftool-perl`
on Debian — and `app/node_modules/exiftool-vendored.pl`, 21 MB of Perl, can go.
Nothing to configure: with the bundled copy absent, `/usr/bin/exiftool`,
`/usr/local/bin/exiftool` and `/opt/homebrew/bin/exiftool` are tried in that
order, and `EXIFTOOL_PATH` is there for one kept somewhere else.

Take the `.pl` and not the directory beside it: `exiftool-vendored` is the Node
package that spawns the program and pools the processes, and without it there is
nothing left to run what was found. The minimal archive already comes this way.

**And two that cannot.** The SQLite driver and the image processor are native
Node modules rather than libraries: `apt install sqlite3` or `libvips` does
not replace them, and building against a system library would mean compiling
at install time, which is the one thing this archive promises never to do.
See [what else can be thrown away](#what-else-can-be-thrown-away) for what
each of them weighs.

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

## Which architectures, and why only those

x86_64 and arm64, for the archives and for both images. Asked for regularly —
armv6, armv7, riscv64 — and the answer is the same three native modules as
above rather than a decision.

An architecture needs four things to exist before a build can: an official Node
release for it, and a published prebuild from each of the SQLite driver, the
image processor and the terminal. Compiling them on the target is the one thing
this archive promises never to do. Where that stood when this was last checked:

|           | Node                       | SQLite driver | image processor  | terminal |
| --------- | -------------------------- | ------------- | ---------------- | -------- |
| `x86_64`  | yes                        | yes           | yes              | yes      |
| `arm64`   | yes                        | yes           | yes              | yes      |
| `armv7`   | **no, dropped in 24.0.0**  | yes           | glibc only       | yes      |
| `armv6`   | **no**                     | **no**        | **no**           | **no**   |
| `riscv64` | **unofficial builds only** | **no**        | yes, glibc 2.41+ | **no**   |

Node published `linux-armv7l` up to and including 23.11.1 and stopped at 24.0.0,
so the last line carrying it is 22 — which the installer refuses. The images add
a condition of their own: they are built on Alpine, and the image processor
publishes musl binaries for x64 and arm64 only, so 32-bit ARM could not be
containerised even if Node returned.

None of that is ours to fix, and all of it is checkable. If the four boxes fill
for an architecture, say so on the issue tracker: the build already runs one job
per architecture, so adding a row is the small part.
