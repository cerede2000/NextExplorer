# NextExplorer without Docker

Everything needed to run it is in this archive, including the Node runtime and
7-Zip. Nothing is compiled, and nothing has to be installed first.

```sh
tar -xzf nextexplorer-<version>-linux-<arch>.tar.gz
cd nextexplorer-<version>-linux-<arch>
sudo ./install.sh
```

**If this is the `-minimal` archive**, it brings no Node runtime, no ExifTool
and no 7-Zip: 103 MB unpacked instead of 263, for a machine that already has
Node 24. Name that Node, because under `sudo` the PATH is root's
and not yours:

```sh
sudo ./install.sh --node "$(command -v node)"
```

Anything that is not Node 24 is refused here rather than three seconds after
the service starts: the native modules in this tree are prebuilt for one ABI.
Everything below applies to both archives.

That makes a system account, puts the program in `/opt/nextexplorer`, writes
`/etc/nextexplorer/nextexplorer.env`, and starts a systemd service. Open the
address it prints and make the first account.

**Prefer not to run a script?** The guide has the same thing as eight commands
you can read first — `groupadd`, `cp`, two `sed`, `systemctl` — and the page is
what CI runs on every release, so it cannot drift from this archive. It also
covers running the program straight out of this folder, with no account, no
unit and nothing under `/etc`, so that `rm -rf` on the folder is the whole
uninstall; and using a Node you installed yourself, if you would rather not
keep the bundled one.

Five optional tools come from your distribution — video thumbnails, fast
content search, text out of PDFs, RAW metadata, and copying with progress. The
script says which are missing, what each one buys, and offers to install them.
The application runs without any of them.

## Updating

```sh
sudo nextexplorer-upgrade
```

It reads the latest release, checks the archive against its published checksum,
and installs it. Your configuration file, your database and your files are left
alone. `--check` says what there is without changing anything.

Running `./install.sh` again from a newer archive does the same thing.

## Where things are

|                                      |                                                  |
| ------------------------------------ | ------------------------------------------------ |
| `/opt/nextexplorer`                  | the program — replaced wholesale on every update |
| `/etc/nextexplorer/nextexplorer.env` | your configuration, written once and never again |
| `/var/lib/nextexplorer`              | the database and the keys — **back this up**     |
| `/var/cache/nextexplorer`            | thumbnails and the search index, all disposable  |
| `/srv/nextexplorer`                  | the volumes: each folder in here is one          |

```sh
systemctl status nextexplorer
journalctl -u nextexplorer -f
sudo systemctl restart nextexplorer    # after editing the configuration
sudo ./install.sh --uninstall          # removes the program, keeps your files
```

## What this is not for

The bundled runtime is linked against glibc, so on Alpine or another musl
system use the Docker image. Same for Windows and macOS: there is no release
here for them.

Full documentation: <https://cerede2000.github.io/NextExplorer/installation/standalone>
