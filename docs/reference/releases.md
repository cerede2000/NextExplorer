# Changelog

Release notes for NextExplorer. GitHub remains the source of truth: https://github.com/cerede2000/NextExplorer/releases

Releases up to v2.0.7 were made upstream, at https://github.com/vikramsoni2/nextExplorer/releases.

Releases are listed newest to oldest.

## v3.11.0 (2026-09-22)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.11.0)

### `Docs` and `docs` are two folders

On a Linux volume they are, and six places disagreed. Each found "a path and
everything under it" with `LIKE 'prefix/%'`, which SQLite matches without regard
to case for ASCII, so an operation on one folder reached its neighbour with the
other spelling.

The worst of it is the shares. Renaming `Docs` re-pointed the share links of
`docs/…` at the new name: a link to `docs/report.pdf` afterwards opened
`Papers/report.pdf`, which is `Docs/report.pdf` — **another file than the one
its owner shared**, handed to whoever held the link. Deleting `Docs` counted
those links in the confirmation and then deleted them. Moving it reassigned the
version histories of `docs/…` to files under the new name, and deleting it for
good purged them. Favorites, recent destinations and folder preferences went the
same way.

The search index had the same fault twice: excluding or deleting `Archive`
forgot `archive` with it, and moving a folder carried the other one's rows along
to a path that does not exist. Moving also wrote the wrong parent on every row
it moved — the expression kept the slash, so a file in `Papers` had `Papers/`
for a folder. A search started from `Papers` missed every file directly in it,
and the next pass took that for a folder that was gone, forgot all of it, and
read every file again, text extraction included. An index a move already wrote
wrongly is mended once, when it is opened.

Every one of them now selects by bounds on the path — `= prefix`, or
`>= 'prefix/'` and `< 'prefix0'`, `0` being the character after `/` — comparing
bytes, which is what the disk does. Where the column has an index, the query
uses it instead of scanning the table.

### A search that gives the server back

Two more answers to [#11](https://github.com/cerede2000/NextExplorer/issues/11),
the instance with a hundred thousand documents on an SMB mount.

**Excluding a folder** from Settings removes its entries from the index straight
away, which is right: until then the index goes on answering from a folder
somebody said not to read. It did it one row at a time, each its own
transaction, on the only thread the server has — two seconds of silence for
fifty thousand files, and the application looked hung. Now a thousand rows per
transaction with the event loop given back between two: fifty thousand rows in
160 ms, never blocking for more than 4 ms; three hundred thousand in 1.1 s,
never more than 34 ms at a stretch. Deleting a large folder, or moving one out
of the volume, took the same path.

**The line under a content match** is read back from the file, since the index
keeps words and not text. That was meant to be one read per result shown. It was
one per candidate, one after the other, for up to three pages of them and before
permissions were asked — each PDF read whole and converted again. Two hundred of
them now answer in 442 ms where they took 2.8 s. Permissions come first, reading
stops at what the page can hold, four files are read at once, and past half the
search budget the rest are given without their line, labelled as found by their
contents.

### Who an access rule holds

An administrator sat outside read-only rules and inside hidden ones. That is
neither, and it was written nowhere: a read-only rule left the Create button on
the folder, and an administrator who pressed it wrote where an ordinary account
could not ([nxzai#407](https://github.com/nxzai/NextExplorer/issues/407)), while
a hidden rule took a folder away from the very account meant to manage it.

It is one switch now, the same whatever the rule grants: **a rule says whether
it holds administrators**, and one setting above the list holds them to every
rule at once. A rule they are not held to is passed over rather than obeyed, so
a later rule still has its say. What a rule stored before the switch existed
means is what it did then — hidden held them, read-only did not — so an upgrade
moves nothing until somebody ticks a box.

A folder a rule holds you to reading now **carries a lock in the listing**,
drawn where the restriction begins and only for the accounts the rule actually
holds. Saving the rules used to switch the setting above them back off, and a
request carrying only the setting stored nothing at all; each half is taken now
only when it was sent.

### A volume that cannot be written in says so

A volume bound `:ro` in a compose file, or owned by a user the container does not
run as, looked like any other: New, Upload and Delete were offered, and each
ended in `EROFS: read-only file system` as a 500 once it had been chosen. The
server asks the system now, with one `access(2)` call, whether it may write where
it is asked to list, and says which it was — `storage` for a read-only mount,
`permission` for a folder its user may not write in. Either takes every write off
the listing, for everyone. The home page and the sidebar show a small lock beside
such a volume, and a write that still reaches a read-only mount is answered 403
in words rather than 500.

### Choosing the folder a rule protects

A rule is matched against the path as NextExplorer shows it, volume first.
Nothing said so, and the field took anything: `mnt/torrents`, typed from the
container's side of the mount, was saved without a word and protected nothing.
There is a button beside each path now that opens the storage picker, the page
asks the server what a typed path names once the typing stops, and it warns —
with the folder probably meant one click away — when one names nothing or lies
outside the volumes. A warning and not a refusal, since a rule may be written for
a folder about to be created. The page also says plainly who the rules restrict,
which the guide and the troubleshooting page had both been getting wrong.

### A row forgets what the server has stopped saying

A new listing was folded into the one on screen with `Object.assign`, which can
only add and overwrite, so a field the server stopped sending stayed on the row
and each one that went quiet needed its own line to be noticed: the badge on a
document no longer being edited, the count on a file whose last version had been
deleted, and then the new lock, which stayed after its rule was lifted until the
page itself was reloaded. One defect, answered once: the client puts exactly two
things on a row the server knows nothing about — a thumbnail it fetched, and the
note that there is none — and everything else the new answer does not carry is
taken off.

### The document's own close button

Collabora draws no close button unless it is asked for one, so the page floated
its own over the editor's toolbar, where it read as something the editor had not
finished drawing ([nxzai#303](https://github.com/nxzai/NextExplorer/issues/303)).
It is asked now, and pressing it closes the document the same way the page's own
button did — a document in a tab of its own closes the tab. The floating button
stays until the editor says the document is up, which is the case it exists for:
a document that never opens draws no toolbar, and with it no way out.
ONLYOFFICE has been asked the same thing all along.

### Every tab says which page, and which instance

The tab held the page alone, and "the page" was the last segment of the path
whatever the page was, so every settings section, the search and both lists of
shares read "Volumes", in English; the editor set no title at all, and the top of
a share read the token. Every tab now reads the page, then the name set in
Settings → Branding: `Projects | Chez Benjy`. Suggested in
[nxzai discussion #395](https://github.com/nxzai/NextExplorer/discussions/395).

### The space a name was cut on

A name in the listing is drawn in two halves so its end stays readable when the
row is narrow. Both halves dropped the white space at their edges, so a split
landing on a space ate it: `02. Test messagerie` was listed as
`02. Testmessagerie`, while the rename box showed the real name. Only the space
on the cut disappeared, which is what made it look arbitrary
([#14](https://github.com/cerede2000/NextExplorer/issues/14)). Nothing in jsdom
could have caught it — the space is in the DOM either way and it is the layout
that drops it — so the guard is a browser fixture on the real stylesheet.

## v3.10.0 (2026-09-21)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.10.0)

### Other people's personal folders, offered by the search

Personal folders sit in `<volume>/_users` unless `USER_ROOT` says otherwise,
inside the tree everybody browses. Since 3.5.0 opening `_users/bob` through the
volume has been refused; asking whether it may be read still said yes, because
the volume's rules had no reason to wonder whose folder it was.

The search asks exactly that of paths it never opens. ripgrep, which the image
ships, lists every file under the volume, and the search index reads all of it
too — so an ordinary account searching the volume was offered other accounts'
files, by name and by the line that matched. The JavaScript walk stepped over
`_users` by name, which is why a machine without ripgrep never showed it; with
`USER_ROOT` inside the volume under any other name, the walk did the same.

The access check now gives the answer that opening the path gives, and so does
every other way into the same folder: an assigned volume that holds it, and a
share of a folder that holds it. **Present since 3.5.0 in the default layout.**
Update if people who are not administrators have accounts on your instance.

On the way: searching for an account's name offered a folder of that name at
the root that does not exist — `_users/bob/notes.txt` read as `bob`, by stepping
over the segment the search should have stopped at.

### A search that does not walk a network share

Reported in [#11](https://github.com/cerede2000/NextExplorer/issues/11): an
instance with a hundred thousand documents on an SMB mount, a search that came
back by timing out, and a file that could not be found by typing its name.

The index answered contents and never names. A name search enumerated the whole
tree on every request — invisible on a local disk, where fifty thousand files
answer in 143 ms, and the entire cost on a network share, one round trip per
folder. Every file and folder has a row in the index now, and a name search
reads it: at half a million rows, a name that matches nothing takes about
40 ms. Measured on twenty thousand files, the pass costs 2 % more time, 239
bytes of index per row and 6 MB of peak memory.

A share, a personal folder and an assigned volume are answered from the index
too, where they were read from the storage on every keystroke — and a search
inside a share answered nothing at all whenever the index was on, which had
been true of contents since the index existed.

What a reader sees:

- **Three characters, and the beginning of a word.** One or two letters
  describe most of a volume and get an answer rather than a search. Through the
  index `azul` now finds `azules`, where it found nothing; the middle of a word
  — `ules` — is still only found by reading the files.
- **Ranked.** The whole name first, then a name that begins with the term, then
  one that holds it; contents by relevance, and by folder when that ties, so a
  folder's files arrive together.
- **Each result says why it is there** — its name, its contents, or both.
- **A short answer says so.** A search stopped by its time budget looked exactly
  like one that had seen everything. A full page says it is the first hundred,
  and more can be asked for — three hundred, then five hundred.
- **`.git`, `node_modules`, `dist` and `build` are searched.** They were skipped
  by name, an editor's habit, on a file server where they are folder names like
  any other. What search leaves alone is the administrator's list,
  `SEARCH_INDEX_EXCLUDE`.
- **An accent is an accent**, however the machine that wrote the name encoded
  it: a `Résumé.pdf` that arrived from a Mac is found by typing its name.

An installation whose index is already built goes on answering names by walking
until its next pass has been all the way round — the hourly one — and then
stops. Nothing has to be rebuilt.

### Two switches in Settings, and what is missing where you can see it

Both asked for in [#9](https://github.com/cerede2000/NextExplorer/issues/9).

- **The search index and folder sizes** each have a switch on their own
  Settings page, and start or stop at once. `SEARCH_INDEX` and
  `FOLDER_SIZE_MODE`, when they are set, still decide: the page shows the value
  in force and names the variable. Nothing else moved out of the environment,
  on purpose — the terminal, the paths, the secrets and proxy trust widen what
  an administrator's session can do, and a stolen one should not be able to
  widen them.
- **The optional tools, with their versions, at start.** One line lists the
  tools the server found, each with the version it reports — `ffmpeg 8.1.3`,
  asked of the binary the application runs. Then one line per missing tool says
  what its absence costs and which package brings it back, not always the
  tool's own name, and 7-Zip says which formats it cannot open. The same list,
  versions included, is on **Settings → About** for an administrator.
- **The machine's own ExifTool is found** without `EXIFTOOL_PATH`, when the
  archive's is not there.

### ffmpeg 8.1.3, in both images

8.1.3 came out the day of this release, and three of its fixes close CVEs the
8.1 branch had not had until then, in decoders an uploaded video reaches when
its thumbnail is made: CVE-2026-66038 (a heap disclosure in LCL),
CVE-2026-70629 (uninitialised data out of RSCC) and CVE-2026-70631 (a TIFF
strip inflated short).

- The **lean** image compiles it, as it compiled 8.1.2.
- The **full** image takes ffmpeg from Alpine, which is still on 8.1.2. Rather
  than wait, it builds Alpine's own package from Alpine's recipe and changes
  only the version: the same options, patches and libraries, so VA-API, VDPAU,
  Vulkan, QSV and every external decoder are what they were. It installs
  whichever is newer, that build or Alpine's, so the weekly rebuild returns to
  Alpine's package by itself once Alpine catches up.

The image build now checks that both carry at least the version pinned. ffmpeg
9 is not in this, deliberately: every fix in 9.0.1 and 9.0.2 that touches code
8.1 has is in 8.1.3, and 9 adds nothing this application uses.

### The minimal archive, back to the Node it can run on

v3.9.3's installer accepted Node 24 or 26, from what the three native modules
publish on npm. An archive carries one prebuild of the SQLite driver, for the
Node that built it, and under the other major the service stopped a few seconds
after starting, on `NODE_MODULE_VERSION`. Reported from a VM in
[#9](https://github.com/cerede2000/NextExplorer/issues/9).

The archive now records the major it was built on, in `NODE_MAJORS`, and the
installer accepts that one and nothing else. **The `-minimal` archive takes
Node 24.** The day it is built on two, it will say so itself.

### The API, described

A running instance serves an OpenAPI 3.1 description at `/api/openapi.json`,
and [a page of this documentation](/reference/api-explorer) lists every
operation: all 164, written by hand and held to the code by tests — every
mounted route described and nothing else, the access each one needs checked
against the guard that enforces it, and a walk through all of them whose
answers must fit the schemas it states.

Writing it found two defects. A `read` API token could not download a
selection, because the gate allowed it at an address nothing is mounted at; and
the reference gave the health check as `/api/healthz`, where it has always been
`/healthz`.

### HTTPS with Let's Encrypt, in front

[Reverse proxy](/installation/reverse-proxy) now shows it end to end with
Traefik and with Caddy — the certificate, its renewal, the redirect from port
80 — and what each has to be told: Traefik cuts any request at 60 seconds
unless `readTimeout` is raised, which stops a large upload half-way. The
application does not serve TLS itself, as asked in
[#13](https://github.com/cerede2000/NextExplorer/issues/13): a certificate read
once at start goes stale at its first renewal, and a proxy already solves that.

The standalone page also says which architectures exist and what decides them
([#12](https://github.com/cerede2000/NextExplorer/issues/12)).

### Smaller

- A document or a file opened in a tab of its own closes that tab from its
  close button, instead of turning it into a second explorer — and only when
  the tab was opened for it, so a tab somebody opened the whole application in
  is never closed under them.
- A notification leaves the screen when its time is up. It stayed until the
  next one arrived.
- The warning that a document about to be deleted is open in ONLYOFFICE was
  written in French, whatever the language. It is in all fifteen now.
- The upload engine loads when an upload is about to start rather than with
  every page: the first load is 39 kB smaller, gzipped.

## v3.9.3 (2026-09-19)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.9.3)

### An archive with no runtime, and two Nodes it will take

The `-minimal` archive refused anything but Node 24, and the reason given was
that the three native modules are prebuilt for one ABI. That had stopped being
true and nothing noticed. Measured in the versions this tree ships: the image
processor is N-API and takes any major, the SQLite driver publishes prebuilds
for 24, 25 and 26, and only the terminal still stopped at 24 — and it had
moved too, in a release from July that carries the missing ABIs for glibc and
musl both.

So that one package is bumped, exercised against a real pty rather than
assumed, and `install.sh` holds a list instead of a number: **Node 24 or Node
26**. Node 25 is left out because it reached end of life on 31 March 2026, not
because it would fail to load. Node 26 is the ABI that becomes long-term
support in October.

Nothing that ships moves. The image, the full archive's bundled runtime, the
workflows and the manifests are still on 24, the line supported until 2028 —
one major is shipped because the archive carries one runtime. The list is what
an archive carrying none will take from the machine.

Two tests hold the halves apart. One reads the ABIs the terminal package
actually carries and refuses a list naming a major nothing has a prebuild for,
so the list cannot promise what would fail three seconds after the service
starts. The other checks the documentation against that same list rather than
against a number, because the page names Node 25 on purpose, to say why it is
not offered.

### The archive without ExifTool took the wrong half of it

The `-minimal` archive leaves out what a distribution can supply, and ExifTool
is one of those: `apt install libimage-exiftool-perl`, `EXIFTOOL_PATH` at the
one it installed, and RAW photo metadata goes on working. It did not go on
working. Reported from somebody packaging this for a distribution, in
[#9](https://github.com/cerede2000/NextExplorer/issues/9).

The archive removed `exiftool-vendored*`, and that pattern matches two
packages rather than one. `exiftool-vendored.pl` is the 21 MB of Perl — the
program itself, and the right thing to leave behind. `exiftool-vendored` is
the Node package that spawns it and pools the processes. With the second gone
there was nothing left to run what `EXIFTOOL_PATH` named, so RAW metadata was
lost rather than handed over — and quietly, because a missing ExifTool is a
supported state: the module is loaded in a `try`, its absence sets the handle
to null, and the application carries on without that one feature. The 1.8 MB
driver's own dependencies travelled in the archive all the same, with nothing
left that reads them.

The pattern is `exiftool-vendored.*` now, which keeps the driver and drops the
Perl. The test runs that line out of `assemble.sh` against a stand-in tree
rather than restating it, and ties what survives to the name the service
actually loads.

Two places on the installation page gave the same wrong instruction to anyone
trimming the full archive by hand — delete `exiftool-vendored*` and set the
variable — and both now name the `.pl`. The page also says plainly what the
minimal archive gets back, and how.

Only the `-minimal` archive was affected, in v3.9.0, v3.9.1 and v3.9.2 — every
release that has carried one. The full archive and both images ship ExifTool
and were never touched by this.

## v3.9.2 (2026-09-19)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.9.2)

### What a deletion takes that nothing showed

A file is one line in the folder and its earlier versions are none, so
deleting it for good read as one thing going when it could be ten — and
versions are the half that no trash and no restore brings back.

The confirmation now says so before the button is pressed: how many earlier
versions are about to go and how much they hold. Only for what is not coming
back — a file going to the trash keeps its history and gets it back when it
is restored, and a warning that does not apply is worse than none. A folder
counts what every file under it would take with it.

The activity log says it too, on a line of its own beside the deletion
(**Versions deleted**), because one line saying a file went is not an account
of ten copies of it going. Versions deleted from the panel, and by an
administrator from **Settings → File versions**, are recorded the same way —
until now the first wrote nothing at all, so the log answered "nobody" to the
only question it is asked about a history that is no longer there.

### A deletion that was written down as something else

With the trash switched off, every file deleted was recorded in the activity
log as having been moved to a trash that does not exist. Reported from an
installation running with it off.

The line was the only thing wrong. The deletion reads the settings on the
server, so the file did go for good; it is the account of it that disagreed.

That account was written from the `permanent` flag the request carried, and
the flag answers a different question. The interface sends it to pick, item by
item, what the trash will not take. With no trash there is nothing to pick, so
it sends nothing — and "nothing" was read as "into the trash".

The service already answers for each item, `trashed` or `deleted`, and that is
the only account that cannot disagree with what happened. The line is written
from there now, one per outcome, so a selection partly kept and partly removed
says both instead of repeating the first.

Two more went with it. An entry that was already gone was counted among the
deleted, and so was one the trash refused for its size and left exactly where
it was. Neither writes anything now, and the name on the line belongs to
something that actually went.

Present in v3.9.0 and v3.9.1. Nothing was lost or misplaced by it — only
misreported.

## v3.9.1 (2026-09-19)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.9.1)

### An empty panel on the way back from a document's history

Reported from a real installation, and the reason was a disagreement about
who owns a DOM node.

The Document Server's script does not draw inside the element it is handed:
it takes that element out of the page and puts its own frame where it stood.
Measured on a live instance, `document.getElementById(...)` answers nothing
while the editor is running. The application still held the removed element
as the editor's own, so rebuilding the editor — which is what leaving the
history does — asked the browser to insert a new one next to a node that was
no longer anywhere. The render threw, nothing drew after it, and what was
left was an empty panel with no message: the only thing still on screen was
the floating close button, which is only there while no editor has reported
itself ready.

A rebuild over the same document no longer goes through the framework at all.
The editor is handed a new configuration, which is its own way of being
rebuilt: it destroys itself and attaches again to the same element while
nothing around it is redrawn. Three paths take it — leaving the history,
restoring from the history, and the fallback for a Document Server too old to
swap a file in place. Opening a different document, or a version read-only,
still builds from nothing, and so does a rebuild whose configuration never
arrived: there is an error to show, and the editor has to make way for it.

The editor's element also carries a generation now, so an entry left in the
Document Server's registry by a teardown that failed cannot keep the next
editor from attaching.

The tests could not have caught any of this: the editor was stubbed as an
empty element that was always ready. It is the library's real contract now —
the asynchronous attach, the registry it refuses to attach twice into, the
teardown, and the rebuild-in-place.

### A file that has a history says so

Versions have been kept since v3.6.0 and nothing in the interface said a file
had any. They were found by right-clicking a file and looking, which works
for the file you already suspect and for no other.

A file with earlier versions now carries a small mark on its row, with how
many; clicking it opens the Versions panel. It is on by default, and
**Settings → Preferences → Mark files that have versions** turns it off,
which takes the query away as well as the icon. It appears only where the
history itself would be shown, so a share that does not hand out histories
does not hand out the mark either.

It costs one query per folder rather than one per file: a folder's children
are a range in the index the histories are already kept under, so three
hundred files cost what three cost.

### Every file that has a history, in one list

**Settings → File versions**, for administrators: every file in the
installation that has earlier versions, where it is, how many, what they
hold, and what became of the file — present, in the trash, or gone from the
disk outside NextExplorer, which is the case nobody goes looking for and the
one where the versions are the only copy left. Ordered by space used,
searchable by path, and the versions are deletable from there, singly or
whole.

A history is named by its own id rather than by a path, because the
interesting ones have no file left to be authorised against. The list shows
paths from every space, personal folders included, which no account can
otherwise see of another — hence administrators only, and hence a deletion
from it is written to the activity log.

### Also

- The settings navigation could not be scrolled, so a tenth administrative
  entry put the last ones out of reach.
- Deleting versions from the Versions panel left the listing behind it
  showing the old number.

## v3.9.0 (2026-09-19)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.9.0)

### A credential for a script, narrower than the account it belongs to

The HTTP API authenticated by session cookie only. Anything driving this
server from a script signed in as a person and held a full session: as wide as
the account, as long-lived as the session, and impossible to take away without
changing the password — which takes every other script down with it.

An **API token** is the opposite of all three. Issue one from **Settings → API
tokens**: it is named, shown once, stored as a hash, and revoked on its own.

- **`read` or `read and write`.** A read-only token reaches `GET` and `HEAD`,
  and the one read that arrives as a POST — downloading a selection, because a
  hundred file names do not fit in a URL. A write token does what its owner
  does with files.
- **Two doors stay shut whatever the scope**, and whoever owns it: the account
  (`/api/auth/*`, so a token cannot change a password, add a passkey or issue
  another token) and administration, including the terminal and the live
  editors. `GET /api/auth/me` is the exception, so a script can ask who it is
  without being able to change who it is.
- **The value is presented in an `Authorization: Bearer` header and nowhere
  else.** Not a query parameter, which lands in every access log; not a cookie,
  which a browser attaches to a request another site made.
- **Every unusable token is refused the same way** — forged, unknown, revoked,
  expired — so a stolen value learns nothing from the answer. Which of the four
  it was goes to the activity log instead, once an hour per token rather than
  once per request.

[Driving the API](/reference/api) has the whole of it, and
[a test plan](/testing/api-tokens) is what to try by hand.

### An authentication gate that did not hold

Found while attacking the tokens on purpose, and older than them.

Express matches routes without regard to case, so `/API/anything` is the same
route as `/api/anything`. The authentication gate compared the path as it
arrived, answered "this needs no identity" to anything not spelled `/api`, and
**skipped itself**. Measured before the fix, with no credential at all:
`/API/volumes` answered `200` and so did `/API/settings`.

Nothing was granted — no session was attached either, so the routes that ask
who is calling refused, and what came back was an empty list and the public
branding. It was a gate that did not hold in front of routes entitled to
assume it did. It decides on a folded path now, and a test holds every
spelling to the same answer.

### A document has an address

Opening a document filled a panel over the folder it was in, driven by a store
the browser knew nothing about: nothing could be linked to, nothing kept as a
bookmark, the back button did not close it, and two documents could not be open
at once.

Every document now has a URL of its own, `/open/<path>`. **Settings →
Preferences → "Open documents in a new tab"** makes a browser tab the default,
for every kind of file at once — a photograph, a PDF, a spreadsheet in
ONLYOFFICE or Collabora, a file the text editor opens, inside a share as well.
Off by default, so nothing changes for anybody who does not ask for it.

Closing the tab ends the editing session exactly as closing the panel does:
`/api/onlyoffice/session-end` queues the last save and then lets the session
go, and both ways of closing use it — a page being unloaded has one
synchronous moment and cannot wait between two requests. So a document is not
left marked as being edited by somebody who shut their browser.

[A test plan](/testing/documents-in-a-tab) covers the part that needs two
browsers and a Document Server.

### A standalone archive with none of what a distribution can give

[Issue #9](https://github.com/cerede2000/NextExplorer/issues/9) asked for the
smallest possible install. Every release now carries a second archive,
`-minimal` in its name, without the Node runtime, ExifTool or 7-Zip:
**103 MB unpacked instead of 263**, 25 MB to download instead of 74.

```sh
sudo ./install.sh --node "$(command -v node)"
```

`--node` is worth naming rather than leaving to be found: under `sudo` the
PATH is root's, so a Node installed through nvm or fnm for your own account is
invisible. Anything that is not Node 24 is refused at install time rather than
a few seconds after the service starts, and `nextexplorer-upgrade` keeps the
flavour it finds installed.

Two variables let the full archive shed the same weight: `SEVEN_ZIP_PATH` —
which existed in the code and nowhere in the documentation — and the new
`EXIFTOOL_PATH`. Which archive formats can be opened is read from `7z i` at
startup rather than assumed, so a 7-Zip without the RAR codec loses RAR and
nothing else.

### The standalone install was quietly slower than the container

The image has set `UV_THREADPOOL_SIZE=16` since it was built and the systemd
unit did not. Every filesystem call, every hash and every image the processor
resizes goes through those threads, and libuv gives four by default. The unit
sets it now, and a test holds it there.

### Node 24, pinned where a shell will read it

`.nvmrc` is new, and a test takes the major from the root `package.json` and
holds the fourteen files that name one to it — the image, the archive's
runtime, the installer's refusal, six workflows, three manifests and the
standalone page. The suites also say so out loud when they are running on
another major, because this repository was worked on for a while from Node 25,
which reached end of life on 31 March 2026.

## v3.8.1 (2026-09-18)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.8.1)

### Four places where content had nowhere to go

[Issue #10](https://github.com/cerede2000/NextExplorer/issues/10) reported that
a Markdown or YAML file longer than the window could not be scrolled in Firefox.
Measured in both engines, Firefox was not the fault: it was broken everywhere.

- **The editor.** CodeMirror grows with its document unless it is told to fill
  its host, so a 900-line file drew an editor 20,000 px tall inside a page whose
  root clips at the window. There was no viewport anywhere and the wheel moved
  nothing in any browser. What differed between engines was only what the
  keyboard did — moving the caret scrolls a clipping container by as much as
  each one chooses, 57 px a press in one and 9,747 in the other — which is what
  made it read as a browser quirk.
- **The search results showed ten matches of a hundred.** Every other list here
  scrolls its own list; this one drew all of them into a box that clips, with no
  scrollbar anywhere.
- **The dashboard clipped its last volumes**: 460 px of 1,120 unreachable at
  thirty-one volumes, which is a number of mounts an ordinary NAS has.
- **The sidebar could only be scrolled by a pointer hovering it**, because that
  is how its scrollbar was hidden — `overflow-y: hidden` until `:hover`. On a
  touch screen nothing hovers, so 897 px of it had no way in at all. The
  scrollbar is still hidden until hover; the scrolling is not.

The last three were found by looking for the shape rather than the case:
content taller than its box, with nothing scrollable between it and the first
ancestor that clips.

### The search is what is left behind

Three tests now fill the installation with more than fits — thirty volumes,
three hundred files, a nine-hundred-line file, a hundred search results — and
walk the screens, the panels and dialogs that open on top of them, and all of it
again at a phone's size. Any box taller than its content with no way to reach
the rest fails the build, naming the screen, the element and the pixels lost.
Four fixture tests cover the editor's own contract, and they run in Firefox as
well as Chromium, because this was reported against Firefox and only a second
engine could say whether that mattered.

All of them fail on the old code.

## v3.8.0 (2026-09-18)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.8.0)

### Install it without Docker

Every release now carries a Linux archive, for x86_64 and arm64, that installs
the application as a systemd service:

```sh
tar -xzf nextexplorer-3.8.0-linux-x64.tar.gz
cd nextexplorer-3.8.0-linux-x64
sudo ./install.sh
```

- **Nothing has to be installed first and nothing is compiled.** The Node
  runtime travels in the archive, and so does the official 7-Zip build — the
  one with the RAR codec, which the builds distributions package do not have.
- **Five optional tools come from the distribution**: ffmpeg, ripgrep,
  pdftotext, perl and rsync. The script says which are missing, what each one
  buys, and offers to install them through apt, dnf, pacman or zypper — one at
  a time, so a name a distribution does not carry costs that line rather than
  the whole set. The application runs without any of them, and picks them up
  whenever they appear.
- **The same script is the update path.** Run it again from a newer archive and
  the program is replaced while your configuration file, your database and your
  volumes are left exactly as they are. It also installs `nextexplorer-upgrade`,
  which reads the latest release, checks the archive against the checksum
  published beside it, and hands over to that release's own script. Nothing runs
  on a timer: updating a file server is a decision somebody makes.
- **systemd does what the container entrypoint had to do by hand.** No
  `PUID`/`PGID`, no `chown -R`: the unit names the account. It is also hardened
  — the whole filesystem is read-only to the service except its own two
  directories and the volumes, so a volume outside `VOLUME_ROOT` wants a line
  in a drop-in, and a path that does not exist stops the service rather than
  being quietly unwritable.
- **The browser terminal is off in this install**, and that is the reason for a
  default rather than a footnote: in the image it opens a shell inside the
  container, here it would open one on the machine, as the account the service
  runs as.
- **On Alpine or another musl system it says so and stops**, rather than failing
  later: the bundled runtime is linked against glibc, and the image is the
  answer there.
- `sudo ./install.sh --uninstall` removes the program and the service and keeps
  every file of yours.

This answers [issue #9](https://github.com/cerede2000/NextExplorer/issues/9),
which asked for a standalone binary and said an archive would do. A single
binary is not coming, and the guide says why: Node cannot embed a native addon,
and there are three in this tree.

Documentation: [Install without Docker](https://cerede2000.github.io/NextExplorer/installation/standalone)

### Everything follows, on every release

The archive is built and installed by the same workflow that publishes the
images, on every push to `main` and on every release, where both architectures
are attached to the release itself. It is installed for real before it is
published: on a runner with systemd, as root, checking that the service answers
with this version and that the bundled 7-Zip is reachable through the unit's
PATH — then again on a bare Debian and a bare Fedora, where the package manager
has to do its part and no Node exists at all.

Thirteen tests drive the install script in a sandbox for what matters on an
update: a configuration file somebody edited survives, the database and the
volumes survive, a file that left the release stops being installed, two
identical runs change nothing, and an archive built for another architecture is
refused rather than unpacked.

## v3.7.5 (2026-09-17)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.7.5)

### Sign in with a passkey

Any local account can add one in **Settings → Passkeys** and sign in with a
fingerprint, a face or the device's PIN instead of a password.

- **It cannot be phished, watched or replayed.** The key never leaves the
  device, and what it signs names this site: a copy of the sign-in page on
  another address gets nothing it can use.
- **A passkey that was unlocked to be used answers the second factor as well** —
  the device, plus whoever can open it. One used without that unlock still asks
  for the code.
- **The last door is kept.** An account with no password cannot remove its last
  passkey. An administrator can remove all of them from an account, the way they
  can already reset its second factor.
- **No dependency was added for it.** The one serious library exists mostly to
  check which brand of authenticator is being held, which is the one thing this
  deliberately does not want to know; the two ceremonies and a CBOR reader are
  written here, and the tests drive them with a software authenticator that
  encodes CBOR its own way.
- **Browsers only allow this on a secure page served from a hostname**, so it is
  not offered over plain HTTP or on an IP address — the settings page says which
  of the two is in the way instead of showing a button that cannot work.
- Passkeys belong to local accounts. Where the identity provider owns the
  sign-in (`AUTH_MODE=oidc`) they are not offered at all.

### An activity log, off unless somebody asks for it

**Settings → Activity log** turns it on, and nothing before that moment is in
it. Seventeen kinds of event: who signed in — including who tried and failed,
and under what name — what was downloaded, uploaded, sent to the trash, restored
or removed for good, what left through which share link and what arrived through
one, every change to a password, a second factor or a passkey, and every account
or setting an administrator changed.

- **Administrators read it**, filtered by kind, by account, by outcome or by
  words, and paged from the moment of the last line rather than by an offset, so
  lines arriving while somebody reads do not shift the page.
- **Emptying it leaves the line that says who emptied it**, with how many lines
  went. It is written after the deletion, which is what makes it the only one to
  survive.
- **Off costs nothing measurable** — 0.017 ms per event that is not written —
  and the retention is swept hourly whether it is on or off, so switching it off
  hands the disk back instead of freezing yesterday.
- **Nothing here can fail the request it describes.** A download does not stop
  because a line could not be written.
- **No link to the accounts table.** Removing an account takes its files and its
  sessions; what it did while it existed is precisely what a log is for, so the
  name is copied into the line.
- **Which events are recorded is not a setting**, and that is a decision rather
  than an omission: every comparable project offers one switch, a retention and
  filters when the log is read. The reasoning, and what was checked, is in
  `TODO.md`.

### The address in a line is the person's, not the proxy's

Every line carried whoever opened the socket, which in a container is the Docker
bridge as often as it is anybody: `172.18.0.1` line after line, and nothing to
say why.

- **One helper now decides the address** for everything that writes one down —
  the log, the share counters, the refused-passkey warning.
- **`CF-Connecting-IP` first**, which is what Cloudflare sets in front of a
  tunnel on a public hostname, then `X-Forwarded-For`, then `X-Real-IP` — nginx's
  own example configuration sends that one and not the first, which left those
  installations naming the proxy on every line.
- **Only from a proxy `TRUST_PROXY` says may be believed.** A log the people in
  it can write is worse than one that names the proxy.
- `::ffff:192.168.1.7` is written the way somebody reading the log would write
  it.
- **A proxy being ignored is now said once**, naming the address it announced
  and the one being recorded instead. And `GET /api/activity/address`
  (administrators) answers the whole question from a browser: what would be
  recorded, the machine at the other end, whether it is believed, the rule in
  force, and every forwarding header that arrived.
- The limit worth knowing: a tunnel that forwards raw TCP rather than HTTP — a
  Cloudflare private network route over WARP, say — has no header to add, and
  nothing recovers an address that never arrived.

### A folder's address reads like a path again

`/browse/Stacks/data`, not `/browse/Stacks%2Fdata`. A router parameter is one
segment, so every slash inside it was encoded; each segment is now encoded on
its own, the way the editor's addresses always were. Addresses already saved
keep working. Apache refuses an encoded slash unless `AllowEncodedSlashes` is
turned on, so this was a 404 waiting behind somebody's reverse proxy.

### Smaller

- Each kind of event is named in the reader's own language, in all fifteen.
- A deletion names the file rather than the folder it was in, and a restore
  names what came back.
- In French the switch read “Enregistrer l'activité” directly above a button
  reading “Enregistrer”: it is “Consigner l'activité” now, and the same
  collision was fixed in Polish.
- Four kinds of event were offered by the filter and written by nothing at all,
  and a deletion from the interface — which goes through a different route than
  the API's — wrote nothing. A test now fails if a kind exists in the list and
  nowhere else.
- The check that every code change carries a test reads the `No-test:` line
  itself rather than asking git for a trailer it cannot parse when the line
  wraps, and it audits the whole range even when an earlier run was cancelled.
- The reverse proxy guide gains the section that explains which address ends up
  in a line, and this changelog gains the v3.7.0 entry it never got.

### Upgrading

Schema 23, two new tables (`passkeys`, `activity_events`), applied at the first
start. Nothing to do by hand, and nothing is recorded until the log is switched
on.

## v3.7.0 (2026-09-16)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.7.0)

### Look inside an archive without unpacking it

A `.zip`, `.7z`, `.rar`, `.iso`, `.tar` or `.tar.gz` opens like a folder —
entries with their sizes and dates, folders to go into, a trail to walk back —
and nothing is written to disk to show it.

- **Read a file inside it:** text and code, Markdown rendered, and the images a
  browser draws itself. Text stops at 2 MB and an image at 32 MB; past that the
  panel says the size rather than freezing the tab.
- **Take part of it out:** one entry or several at once, into the archive's own
  folder or one picked from the same dialog as the rest of the application. A
  folder stands for everything under it, and nothing is ever replaced.
- **Which formats:** whatever the image's 7-Zip reads — zip, 7z, rar, iso, tar,
  gz, tgz, bz2, xz, cab, wim, cpio, rpm, deb and more. A `.tar.gz` is two
  archives, so the tar inside is decompressed once into the cache;
  `MAX_BROWSABLE_ARCHIVE_SIZE` (2 GB) is where the answer becomes “extract it
  instead”.
- **A solid `.7z` is extracted once, on the second read**, measured rather than
  guessed: the first entry of a fifty-megabyte solid archive takes 0.02 s, the
  last 1.37 s, the whole thing 1.41 s.
- Nothing from inside an archive is ever served as a page.

### Two-factor on a local account

**Settings → Two-factor** offers a QR code for any authenticator app, one code
to confirm the phone kept the secret, and ten recovery codes shown once.

- The password alone opens nothing after that: the sign-in waits for a code for
  five minutes, and a wrong one counts against the same lockout a wrong password
  does.
- A code is worth one sign-in, a recovery code one use.
- The secret is unreadable in `app.db`, under a key drawn beside it in
  `/config/totp-key`. Back that file up with the database.
- An administrator can take it off an account that lost both the phone and the
  paper.

### How it compares

The README and the documentation carry a comparison against FileBrowser Quantum
and Filestash, every cell read from that project's own repository, documentation
or pricing page rather than from its marketing — including the rows where they
are ahead.

## v3.6.1 (2026-09-15)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.6.1)

### app.db gives back the space it frees

SQLite keeps what a deletion frees inside the file. An installation reported an
app.db of 2,159 MB holding 160 MB of data — 2,000 MB of free pages, copied into
every backup of `/config`. After upgrading to this release, the same app.db is
434 KB.

- **Once, at the first start**, a database created by an earlier release is
  rewritten so that its free space can be handed back from then on. The log says
  how large it was before and after. On an SSD it took seconds for a 2 GB file.
- **Every hour** after that, free space is handed back once more than 16 MB of
  it has built up, a little at a time, so the server keeps answering while it
  runs.
- **The write-ahead log** (`app.db-wal`) is cut back to 64 MB after a
  checkpoint, instead of staying at its largest size.

### The search index and folder sizes live in /cache

They were most of app.db, and nothing like the rest of it: every row can be read
again from the files, and they are rewritten all day long. They now live in
`/cache/index.db`, next to the sessions, apart from the accounts, shares and
settings that cannot be made again.

- **Carried over, not rebuilt.** At the first start the existing index is copied
  into `/cache/index.db` as it is, then removed from app.db. The volumes are not
  read again for it.
- **Nothing is lost if the copy fails** — no room in `/cache`, say. app.db keeps
  the index, the log says why, and the next start tries again; after three
  starts that all failed, the index is rebuilt from the files instead.
- **Only the indexes are written under `/cache`.** Nothing from the accounts or
  settings passes through it, even during the move.
- **Each file has its own writer**, so an indexing pass and a sign-in no longer
  wait on the same lock.

### A link out of a volume is shown as a link

A symbolic link inside a volume that points outside it — releases 1.1.8 to 2.0.2
left `app.db`, `app-config.json` and `extensions` links in the old cache
directory — was listed with the size and type of what it points at, on a row
where renaming, deleting and opening all failed with "Resolved path is outside
the configured volume root" or "Path not found". Nothing could be read through
such a link, and nothing can now either; the row now says what it is, offers no
action, and opening it explains where to remove it.

### Smaller fixes

- Everything that starts with the server used to open app.db at once, and each
  caller went on to open it again and run the migrations over it: four
  connections at every start. The database is opened once.
- Refusals from the server with a generic code — access denied, not found,
  conflict, too many requests — are headed in your language, with the server's
  own sentence underneath. The browser console no longer fills with vue-i18n
  warnings for codes that have no translation.

### Upgrading

- **Mount `/cache` persistently.** It now holds the search index and folder
  sizes as well as thumbnails and sessions. Without a persistent mount, every
  new container reads the volumes again to rebuild them. It still needs no
  backup.
- **The first start takes a little longer** on an installation with a large
  app.db: the one-time rewrite, and the copy of the index. The rewrite needs
  free temporary space about the size of the data app.db really holds; if there
  is not enough, the server starts anyway and tries again next time.
- **Going back to 3.6.0** after this start works, but 3.6.0 finds no index in
  app.db: search reads the folders as it goes, and folder sizes are measured
  again.

## v3.6.0 (2026-09-15)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.6.0)

### Security fixes

**Upgrade if you share folders, use access rules, or sign in through an identity
provider.** Each of these was found by the tests written for this release and
reproduced before being fixed, and each fix is held by a test that fails without
it.

- **A copy or a move could write outside the folder it was allowed into.** The
  destination was authorized, then the item's new name was joined onto it as the
  request spelled it: `../name` wrote into a parent the caller could only read,
  and from a share into the volume outside it. A new name now has to be a name,
  and without one the item keeps the name it has on disk.
- **A zip of a folder carried what nobody browsing it could see.** A folder
  downloaded as a zip, downloaded through a share link, or compressed in place
  included the paths an access rule hides and a personal folder kept inside the
  volume — and, with this release, would have carried the trash and file
  versions kept in `.nextexplorer`. An archive now holds what a listing of the
  folder shows.
- **Compressing ignored a share that withholds downloads.** A visitor could
  compress a file into a volume of their own and download the archive from
  there. Compressing now needs the right to download.
- **With `AUTH_MODE=oidc`, password setup and password sign-in still answered.**
  On an instance nobody had signed in to yet, anyone who could reach the API
  could make themselves its administrator with a password. Both are refused
  unless password sign-in is enabled.
- **Two first-run setups sent together both created an administrator.** Setups
  now run one at a time.
- **An OIDC sign-in did not check that userinfo described the person signing
  in.** The claims were read from the session the browser arrived with — on a
  fresh sign-in, nobody — so userinfo's subject was compared with nothing. The
  claims now come from the ID token the library verified, and userinfo must name
  the same subject. The same change lets a sign-in go ahead on the ID token when
  userinfo is briefly down, and no longer refuses a second person signing in
  from a browser that held someone else's session.

### Deleting goes to the trash first

Deleting a file or a folder moves it to a trash instead of removing it.
**Trash** in the sidebar lists what was deleted, restores it where it was or
into a folder you choose, restores part of a deleted folder, previews a text
file read-only, and deletes for good. Items leave for good after a retention
period, 30 days by default.

- **No copy.** Each volume keeps its trash in a hidden `.nextexplorer` folder at
  its own root, and deleting is a rename on the same disk: a 40 GB folder goes
  to the trash as fast as a small file.
- **Said before, not after.** An item that cannot go to the trash — on another
  disk mounted inside a volume, larger than the trash's limit, or a volume
  itself — is named in the delete dialog before anyone confirms, with the
  reason.
- **Share links.** What goes to the trash stops being reachable through its
  links at once, and the dialog says so. Restoring asks whether the links come
  back as they were.
- **Crash-safe.** Every step writes what it is about to do before it touches the
  disk; an interrupted delete, restore or purge is finished or undone at the
  next start.
- **Who sees what.** Each person sees what they deleted, administrators see
  everything, and what a share-link visitor deletes goes to the share owner's
  trash.

Documentation: [Trash](https://cerede2000.github.io/NextExplorer/admin/trash)

### Earlier versions of a file come back

Saving over a file keeps what the save replaces — from the text editor, the
editor opened through a share link, ONLYOFFICE and Collabora. Right-click a file
→ **Versions**, or **Versions** in its details: open an earlier version
read-only, download it, restore it, restore it as a copy, put it over another
file, name it, pin it, delete one, several or all.

- **No copy here either.** The replaced content is moved into the same
  `.nextexplorer` folder, and counts against the same space as the trash.
- **One version per office editing session**, not one per autosave: the document
  before the session, a save someone asked for, and at most one checkpoint every
  10 minutes in a long session.
- **Thinned as they age**: every version for 24 hours, then one per hour to 7
  days, one per day to 30 days, one per week after, at most 50 per file. Pinned
  versions are exempt.
- **Inside the editors.** ONLYOFFICE's History lists the versions and restores
  one; Collabora's File → Revision history opens the panel.
- **Shares** have two new options, _Show file versions_ and _Allow downloading
  versions_.

The office side is tested against the ONLYOFFICE callback, WOPI and the signed
history payloads, not yet against a running Document Server or Collabora
instance. Reports are welcome.

Documentation:
[File versions](https://cerede2000.github.io/NextExplorer/admin/versions)

### An administrator can release a locked account

[nxzai/NextExplorer#370](https://github.com/nxzai/NextExplorer/issues/370). Five
failed sign-ins lock an account for fifteen minutes, and until now only waiting,
or editing the database, released it. **Settings → User Management** marks a
locked account with the time it frees itself, its **Security** tab offers
**Unlock now**, and the sign-in screen says how long is left.

### A sign-in survives a provider whose discovery document is down

A 503, a maintenance page, a refused connection or a timeout on the provider's
`/.well-known/openid-configuration` threw out of the callback and refused a
sign-in that had already succeeded. It falls back to the ID token's claims now,
as it already did when the userinfo endpoint failed.

### A refused or missing path answers as one

A file deleted since the listing was drawn, a path climbing out of the volume,
another account's personal folder reached through the volume: each was refused,
nothing leaked, but as a 500 with a stack in the log. They answer 404, 400 and
403 now, across every route that takes a path.

### Smaller fixes

- The account menu, the only way to Settings and to Sign out, opens from the
  keyboard. Its toggle is a real button, announced as a disclosure rather than
  as a menu it is not.
- A folder restored from the trash or extracted from an archive is searchable at
  once, instead of after the next indexing pass.
- Changing a mode keeps the setuid, setgid and sticky bits the item had.
- An owner or a group typed in the details panel and left unsaved is no longer
  applied to the next item the panel shows.
- Assigning a volume to a user can no longer add it twice.
- The thumbnail settings no longer offer to save before they have loaded, which
  could write the defaults over what was stored.
- A refused save of the access rules says why.
- The **Create new** button closes the menu it opened.
- A share created with its history options keeps them; they were dropped at
  creation and only an edit applied them.
- ONLYOFFICE reopens a document renamed from its title bar under its new name,
  and closing while an automatic save is on its way still sends the save on
  close.

### Underneath

- **Coverage, where the data and the access are.** The tests written before this
  release went to what loses data or opens access when it is wrong — uploads,
  copy and move, compressing, permissions, sign-in, OIDC, account changes,
  settings and the screens that edit them — and found the security fixes above
  on the way. The backend went from 84.4% to 86.4% of statements and from 73.2%
  to 75.5% of branches; the frontend from 75.0% to 84.1% of statements and from
  61.3% to 71.9% of branches. The floors that fail a push rose with them.
- **The upgrade itself is tested from the databases earlier releases leave.**
  Schemas from 1.1.7, 1.2.0, 2.1.1, 2.2.7, 3.0.0, 3.1.0 and 3.5.0 are rebuilt as
  those releases create them and upgraded: accounts, sign-in methods, favorites,
  shares, volumes and settings come through, a restart changes nothing, and a
  migration that fails half-way leaves the database as it was.
- A browser journey now runs against the server the image runs: first setup,
  sign-out and sign-in by keyboard, upload, share, the trash and a version
  restore, all checked on disk.
- Every client call is checked against a server route, every code change must
  carry a test in the same commit, and coverage floors fail a push that lowers
  them.
- The HEIC thumbnail tests had never run in CI while reporting green; they run
  on the image's own base now, and each published image must decode the fixture.
- What the tests found and this release does not fix is written down in
  `TODO.md`, with what it costs.

### Upgrading

- **Two schema migrations**, for the trash and for file versions. They run at
  start; going back to 3.5.0 afterwards is not supported — keep a copy of
  `/config` if you may.
- **The trash and file versions are on by default.** The container user needs
  write access at the root of each volume, where `.nextexplorer` is created;
  without it nothing is lost — the delete dialog says the item cannot go to the
  trash and asks before deleting for good. Switch either off with
  `TRASH_ENABLED=false` or `VERSIONS_ENABLED=false`, or in **Settings → Trash
  and versions**.
- **Backups** of your volumes include `.nextexplorer/` unless you exclude it.
- **Shares with named people** that already exist get _Show file versions_ and
  _Allow downloading versions_ switched on; links for anyone get neither.
- **With `AUTH_MODE=oidc`**, the password setup and sign-in endpoints now
  answer 403. Nothing in the interface used them in that mode.
- New optional variables: `TRASH_ENABLED`, `TRASH_RETENTION_DAYS`,
  `TRASH_MAX_PERCENT`, `TRASH_MAX_SIZE`, `VERSIONS_ENABLED`,
  `VERSIONS_KEEP_ALL_HOURS`, `VERSIONS_HOURLY_DAYS`, `VERSIONS_DAILY_DAYS`,
  `VERSIONS_MAX_PER_FILE`, `VERSIONS_SESSION_CHECKPOINT_MINUTES`.

## v3.5.0 (2026-09-10)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.5.0)

### A personal folder is now actually personal

Personal folders default to `<volume>/_users`, which puts them inside the tree
everyone browses. The directory name was filtered out of listings, and that was
the whole of the protection: asking for `_users/alice` by name answered, and the
volume's access rules had no reason to refuse, because whose folder it was never
came up. Measured with an ordinary account holding no admin role, it listed
another account's folder, read a file inside it, and deleted that file — 200
each time.

The personal space itself was never the way in. It derives the directory from
who is asking rather than from what was asked for, so there is nothing there to
aim at. The volume no longer goes there. The comparison is by name, which costs
nothing, and by real path only where the user root sits inside the volume — an
installation keeping its personal folders elsewhere pays for none of it, and one
that points the user root at the volume itself keeps its volume rather than
losing it.

Two smaller things went with it. The documentation said a `hidden` folder stays
reachable by direct path; it does not, the access manager refuses it outright,
and that is corrected. And an account signing in through an identity provider
before it had a row in the database carried no folder name, so one was derived —
from `username` first, which two identities from two providers can share. It
carries the provider's subject now, which is nobody else's.

### The container can be given a user of its own

[#8](https://github.com/cerede2000/NextExplorer/issues/8). The entrypoint used
to renumber `appuser`, take ownership of `/config` and `/cache`, and finish with
`gosu appuser`. All three need root, and under `set -e` the first one that
failed took the container with it before the server existed. That is what
Compose's `user: 1000:1000` gave you, and what a Kubernetes `runAsNonRoot: true`
gives you — a container that dies at startup.

Started as root, nothing has changed: `PUID`/`PGID` still renumber, the
directories are still chowned, the process still drops to `appuser`. Started as
anything else, none of that work is needed — the process is already the user it
was meant to become — so it is skipped, the log says `PUID`/`PGID` are being
ignored and why, and the application runs as whoever the container was given.
A directory that cannot be created is a warning rather than an abort, since the
mount is expected to provide it.

Both published images are started as `1000:1000` in CI on every build, and as
root, so neither half can quietly stop working.

### A session that ends now says so

An expired session used to leave the screen exactly as it was, and every request
behind it failed into a row of error toasts — including our own "Network Error",
whose text suggests looking at `PUBLIC_URL` and CORS. Nothing was wrong with the
deployment; the session had ended, which is a normal thing for a session to do.

The client now recognises it and returns to the sign-in screen. That covers the
plain case, where the server answers 401, and the one behind an authenticating
proxy, where the proxy answers first with a redirect to the identity provider on
another origin — no CORS headers, so the browser reports `TypeError: Failed to
fetch`, indistinguishable from an unreachable server unless you ask.

### A text file opens in whatever it is written in

A 3.5 MB `.txt` was refused as binary. It was not: it was UTF-16, where every
ASCII character is stored with a zero byte beside it, and a zero byte is exactly
what the binary test looked for. PowerShell's `Out-File` wrote UTF-16LE by
default until PowerShell 6 and Notepad still offers it as "Unicode", so a log or
an export from a Windows machine is very often UTF-16. Files are now read in the
encoding they declare.

### A refusal arrives as a refusal

Every access decision in the transfer service raised a plain error, which
carries no status, so being told "you may not" arrived as a 500 with a stack in
the log — an outage, by the shape of it, for a permission working as designed.
It cost the caller too: the uploader does not retry a 403 and does retry a 500,
so a refusal was retried until it ran out of attempts. Refusals are 403 now, a
path that is not there is 404, and a destination that is not a directory, a
folder inside itself, or an operation that does not exist is 400.

### Thumbnail cleanup only counts thumbnails

The cleanup is the only thing between the cache and a full disk, and it deletes
files. The name pattern decided which entries were outdated or expired, then was
dropped for the overflow trim, which took every file in the directory — so
anything else living there counted towards the limit and could be deleted to
satisfy it. The pattern now decides all three.

### Signing in from a native app

The three OIDC bridge routes from upstream are in, which let a native
application finish a sign-in it cannot finish the way the web app does. They
answer 404 unless OIDC is configured, and nothing in the web interface touches
them. Two things were closed on the way in: the session is regenerated at the
exchange, so an identifier known beforehand is not the one that ends up
authenticated, and the redirect target is checked against
`OIDC_MOBILE_REDIRECT_URIS` rather than trusted.

### Underneath

Most of this release is tests — the folder view, the row, the details panel,
the editor, the uploader, the context menu, the sign-in screen, the shared-link
screen, the admin screen, the terminal gate, the WOPI contract, the search index
and the folder-size index. Two of them changed the code they were written
against: copying and deleting have two engines, `rsync`/`rm` and streams/`fs.rm`,
and which one ran was decided by the platform at module load, so each was only
ever exercised where it was chosen and thirty lines of `rm -rf` had never run
on any machine under measurement. The engine is now chosen per operation and
both are covered wherever the tests run.

And a note in `TODO.md` that had gone unexplained for months is resolved: the
search has two content engines, one runs per request depending on whether
`ripgrep` can be spawned, and each machine was covering the size bound the other
one could have deleted for free.

### Upgrading

Nothing to do beyond pulling the image. No schema migration, no configuration
change. `OIDC_MOBILE_REDIRECT_URIS` is new and optional: it names the
custom-scheme URIs the bridge may deliver a code to, and defaults to
`nextexplorer://oidc-callback`. `http` and `https` targets are rejected whatever
it says, so the bridge cannot be turned into an open redirect.

## v3.4.0 (2026-09-09)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.4.0)

### Sign in with a username

Asked for in [#5](https://github.com/cerede2000/NextExplorer/issues/5), and the
reason is a fair one: a username is what somebody chose, an email address is
what their mail provider gave them. The sign-in box now takes either, and the
server works out which it was handed. Case does not matter for either.

The field itself was part of the problem. It was `type="email"`, so the browser
refused a bare name before anything was ever sent — the server never saw those
attempts at all.

Two things had to be settled first, and both are worth knowing about.

A username is not unique in the database. The constraint was lost in an early
migration, and a username is derived from the local part of the address, so
`alice@example.com` and `alice@other.org` both become `alice`. A name that
answers for two accounts identifies neither, and choosing between them would be
choosing whose account a stranger signs into — so it signs nobody in, and those
accounts keep their email address, which is unambiguous by construction. New
accounts and renames are now refused when they would take a username already in
use, so no more are created. An installation that already holds duplicates can
free the name by giving one of the accounts a different one.

And the lockout after repeated failures used to be counted against whatever was
typed. One account answering to two names would have had one budget of attempts
per name, and anyone alternating between them would never have exhausted
either. It is now counted against the account. The counters reset once on
upgrade, which costs at most fifteen minutes of an existing lockout.

### Running as root, written down

[#6](https://github.com/cerede2000/NextExplorer/issues/6) asked how to run the
server as root to reach a root-owned mount, and tried Compose's `user: root`
without effect. That is not the knob: the entrypoint always finishes with
`gosu appuser`, so `user:` decides who runs the entrypoint — already root — and
not who runs the server. `PUID=0` and `PGID=0` do, and nothing said so.

[Running as root](/configuration/environment#running-as-root) now explains it,
along with what it costs: every file created on the host is owned by root, and
a mount of `/` hands over the whole host.

## v3.3.0 (2026-09-03)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.3.0)

### Subtitles, and an answer when a film plays silently

Playback hands a file to the browser and never transcodes: that is a media
server's job, not a file explorer's. The limit is reasonable and it was
invisible, which is not. A film whose soundtrack is AC-3 or E-AC-3 — which is
most films in a Matroska container — plays perfectly with no sound at all in
Chrome and Firefox, because neither will decode those. Nothing on screen said
so, and the only conclusion available was that the file was broken, or that we
were.

The player now reads what the container holds and says which parts the browser
will refuse, naming the codec. It says the same when the picture itself cannot
be decoded, which for a ten-bit HEVC file is the more useful sentence: nothing
was going to appear at all.

Subtitles follow from the same reading. Text tracks inside the file, and
subtitle files sitting beside it — `film.srt`, `film.fr.srt`,
`film.en.forced.srt` — are converted to WebVTT on demand and offered through
the browser's own captions button. Blu-ray and DVD subtitles are pictures of
words; they are listed as unconvertible rather than offered as captions that
would show nothing.

Switching between audio tracks appears only where the browser supports it,
which today means Safari, rather than as a control that does nothing everywhere
else.

### The video control bar is back

Opening a video showed no time bar. Fullscreen had one, which made it read as a
browser quirk.

`max-height: 100%` on the video resolved against a wrapper whose own height
came from its content, and a percentage against an indefinite height computes
to `none`. So the video took its natural size and hung below the frame, which
clips — and the control bar, drawn at the bottom of the element, was off
screen. Measured at 212 pixels below the visible edge in a 1280x720 window.

### A share that can be read without being copied

Turning downloads off leaves a share readable while withholding the file. It is
deliberately independent of read-only and read/write, because "work on this,
but do not take a copy home" is a coherent thing to ask for.

The permission was half there: `canDownload` was consulted by the download
route and set to `true` at every place that produced it, so nothing could ever
withhold it and removing the check broke no test. The frontend hid a button on
a promise the backend did not keep. Every share that already exists allows
downloads, and an update that says nothing about it leaves it alone.

### A smaller image, built rather than borrowed

FFmpeg is now compiled here instead of taken from a distribution or a
third-party static build, with the encoders and muxers this application
actually uses and nothing else. The build proves itself before it is shipped:
25 formats are synthesised and decoded by the binary just built, and the image
refuses to build if any of them fails. That check is the point — a stripped
build fails silently, as thumbnails that simply never appear.

ImageMagick is gone: HEIC is decoded by FFmpeg, whose HEIF demuxer reconstructs
the tile grid an iPhone photo actually is. `fluent-ffmpeg`, deprecated
upstream, is gone with it. A vendored ExifTool and a dependency's own coverage
report no longer reach the image, and xterm is no longer loaded by every page.

`latest-lean` went from 154.2 MB to 112.9 MB, and `latest` from 241.0 MB to
235.8 MB.

### Express 5

The framework is up to date. One route survived the migration in a form Express
5 no longer accepts and stopped the server from starting at all; it was caught
before it reached a release, and the suites that would have caught it earlier
now exist.

### Fourteen languages

Brazilian Portuguese is added. Twelve catalogues that had quietly drifted back
to English are complete again, and the French is finished. A browser announcing
`FR-fr` is matched like one announcing `fr-FR`.

### A file found twice by one search

A `.docx` whose name and its contents both matched a search term came back
twice in the results.

The passes of a search run concurrently and share a set of paths already found,
so that none repeats another's work. That set could not prevent a duplicate: in
the pass that reads Office documents, the test and the claim are three awaits
apart — it checks the path, then stats the file, extracts its text and asks
permission, and only then records it. The pass that matches filenames claims a
path on the line after testing one, so it fits inside that window.

It took a machine slow enough to finish walking a directory while a document
was being unzipped, which is why it appeared in CI rather than on a developer's
machine. The results are deduplicated where every pass converges now, so the
order they finish in no longer matters.

### Failures that name themselves

A thumbnail that could not be made reported "Input buffer contains unsupported
image format" from sharp — an image-format complaint, about a video file, with
nothing to act on. FFmpeg had failed, written nothing, and been handed to sharp
as an empty buffer; its own explanation went to a pipe nobody read. That pipe
was the worse half: an unread pipe fills at 64 KB and the writer then blocks
forever, so a file FFmpeg had a lot to say about would hang rather than fail.

Two diagnostics that stop reporting after ten findings were being spent by
ordinary traffic — video streaming and subtitle extraction hold a connection
open by design — which switched them off for the life of the process. Both now
say they mean to hold.

## v3.2.0 (2026-09-02)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.2.0)

### Search answers from an index, and the volume is left alone

Every search used to read the volume. On a large one that is minutes of disk
for a question asked in a second, so `SEARCH_DEEP` was the setting people
turned off and then stopped expecting search to find anything.

`SEARCH_INDEX=true` keeps a full-text index of the documents instead. It is
built by a background pass that takes the share of one core you give it
(`SEARCH_INDEX_CPU_PERCENT`, a quarter by default), skips everything it has
already read, and stops when the server is asked to stop. Searches outside the
volume root — personal folders, assigned volumes — go on reading as they
always did.

Half an index does not answer a whole search: until a pass has run to the end,
searches read the tree the old way. An index that answered early would report
that a file found yesterday no longer exists, which is worse than a slow answer
and much harder to explain.

### Filename patterns

`*` and `?` in a search term now match filenames rather than text. `*.ps1`
finds the scripts; `conf?g.json` finds either spelling; `Stacks/*/logs/*.log`
reaches across folders. The pattern is matched against the whole name, so
`*.ps1` does not return `deploy.ps1.bak`.

A pattern names a shape, and no file contains the characters `*.ps1`, so
nothing is read inside files to answer one. Before this, `*.ps1` searched the
volume for that literal string: it returned the files that mention the pattern
in their text, took the whole time budget doing it, and returned none of the
scripts.

### Searching inside Office documents and PDFs

A `.docx` is a zip of XML and a PDF keeps its words in compressed streams, so a
plain content search finds nothing in either. Their text is extracted and
searched — including a word an author emphasised halfway through, which Word
stores in pieces. A scanned PDF is a picture of a page and stays unsearchable;
that needs OCR.

### A search answers when it is done, and the newest one wins

Three things were making the search box feel unreliable.

A search waited out its whole five-second budget on a reserve it was holding
for content matches, even when every source of them had already been exhausted.
A budget is a ceiling, and it had become the normal duration.

When the budget did end a search, cleanup ran before the answer: resuming every
source at whatever it was in the middle of took six more seconds on a busy
tree, so a search bounded at five answered in eleven. The bound had not been
raised — the wait had moved past it.

And typing sends one search per pause. Nothing said which answer belonged to
which question, so the panel showed whichever came back last: a list of `.doc`
files under a box reading `*.docx`. Only the newest search may write to the
panel now, superseding one aborts it, and a search whose reader has gone away
stops instead of running to the end for nobody.

### Folders search leaves alone

`SEARCH_INDEX_EXCLUDE`, and a matching list in **Settings → Search index**,
name folders search does not walk into — a Docker overlay, a build tree, a mail
spool. Hundreds of thousands of files nobody searches, and reading them is the
whole overhead.

The list is obeyed by the whole of search now, not only by the index. While
only the index obeyed it, a filename search still enumerated the excluded tree
and could not finish inside its budget: the same `*.xlsx` came back truncated
at 58 matches, then at 57. One question, two answers, cut at a different point
each time.

Standing inside an excluded folder and searching there still works: the list
keeps the crawl out of a corner, it does not make the corner unreadable to
someone who navigated into it.

### The index no longer takes the machine it was borrowing

A first pass over a large volume grew to ten gigabytes and drove a host into
swap.

Every document was indexed through a statement prepared for it and never
finalised. That memory is native, invisible to the heap, and it was three and a
half kilobytes a document — over a gigabyte at three hundred thousand files.
Each pass also allocated a buffer per document and carried a set of every path
it had seen, fifty megabytes at two hundred thousand paths. The statements are
cached now, one buffer is reused for the whole pass, and what a folder holds is
asked of the database instead of remembered.

The pacing was measured wrong on top of that: a fixed pause after each document
paces cheap documents and not expensive ones, so the load was whatever the
files happened to be — a hundred and seventy-five percent of a core at its
worst. A pass now works for a slice of time and stands aside for the rest, so
the share you asked for is the share you get.

When a pass does approach the container's memory limit it stops and picks up a
couple of minutes later, rather than for an hour. It reads the limit the
container actually enforces instead of guessing from the process.

### Large Markdown opens instead of freezing the tab

A six-megabyte Markdown file could be opened in the editor and not in the
preview: the preview parsed and rendered the whole document in one stretch,
which is a frozen tab for as long as it takes.

It is read in slabs sized from what the last one cost, handing the browser back
between them, so the document appears immediately and fills in behind. Slabs
are cut between blocks, never inside a fenced code block, and link definitions
travel with each slab because Markdown resolves them while lexing. Chunks off
screen are skipped for layout and paint but stay in the document, so Ctrl+F
still crosses all of it. `PREVIEW_MAX_RENDER_SIZE` sets the ceiling.

### A search result opens the folder on the file

Clicking a result opened the folder containing the file and left the list at
the top, so a file below the fold looked like nothing had been found. The row
is scrolled to a third of the way down the viewport — what sits above a file is
the context of where it lives.

### The health check answers, and says why when it does not

`/healthz` sat behind the session store and the identity provider. A container
whose provider was slow to answer was reported unhealthy for a reason that had
nothing to do with whether it was serving. The health routes are mounted before
any of that now.

The check itself reported a bare failure; it now says which of a timeout, a
refused connection, or a non-200 answer it saw. A request that is accepted and
never answered is reported with its path and how long it has been held, so a
hang can be told apart from a slow identity provider — and a long-poll a route
means to hold is not reported at all.

### Under the hood

Path containment — the checks that keep a request inside the volume it is
allowed in — stopped the event loop to do its work: `lstat`, `readlink` and
`realpath` were synchronous, and every request pays for them. They are
asynchronous now, and the containment is unchanged.

A pass over code nothing calls removed twenty-one dead functions, fifty-four
unused exports and three hundred and thirty-eight translation strings for text
no longer on screen. Two services that were eighty-two percent the same file —
folder-size exclusions and search-index exclusions — are one factory and two
fifteen-line callers.

**Full Changelog**: https://github.com/cerede2000/NextExplorer/compare/v3.1.2...v3.2.0

## v3.1.2 (2026-09-01)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.1.2)

### A share password is asked for once

Opening a link protected by a password, typing it, and then reloading the page
asked for it again. The reload calls the same endpoint the first visit does, and
the branch that answered had no idea the check above it had already accepted the
session the visitor was carrying — so it sent them back to the prompt for a
share they had just been given.

It came out of straightening the predicate that answers _does this password
apply to this caller?_. It required a signed-in user, so it said no for visitors
with no account at all — the very people a public password is for — and each
caller made up the difference in its own way. Those compensations are gone, and
this was hiding under one of them.

### Two accounts can no longer share one personal folder

Which folder an account gets was derived from `USER_FOLDER_NAME_ORDER` on every
request, and nothing about that order guarantees a distinct answer. `username`
carries no uniqueness constraint, and `bob@a.com` and `bob@b.com` both yield
`bob` under `email_local`. Two accounts that derived the same name were handed
the same directory, and each saw the other's private files.

A default install was never affected — `id` comes first and ids are unique — but
[the documentation recommends](../configuration/personal-folders.md)
`username,id` to reuse an existing `/home/<username>` layout, which is where it
bites.

The name is claimed now instead of derived: the first account to be given one
keeps it, a second walks down its own preference order to the next free name,
and a unique index makes that a guarantee rather than a check two requests could
race past. Accounts that already exist are assigned oldest first, so where an
instance already had a collision, the account that has been using the folder is
the one that keeps it.

::: warning One behaviour changes with this
A name that has been given is kept, so changing `USER_FOLDER_NAME_ORDER`
afterwards applies to accounts created from then on and leaves the existing ones
where they are. It can no longer quietly take a folder away from whoever is
working in it. To move existing accounts deliberately, move their directories
and clear `personal_folder_name` — the [personal folders
page](../configuration/personal-folders.md) has the statement.
:::

### Checking a password no longer holds the only thread

bcrypt is slow on purpose, and its synchronous form stops the server doing
anything else for that time. Verifying a share password is reachable without an
account and rate limited per address, so a handful of addresses could keep the
process busy in a way no other public route can. The asynchronous form runs
now — here and on the sign-in path, which had the same shape.

### Also

- Docker Hub keeps the last two versions. Publishing a third removes the oldest
  and everything that belongs to it, so the page people reach before the
  repository stops being a wall of tags nobody runs.
- The check that keeps a path inside its volume root makes its own containment
  test rather than trusting each caller to have done it first.
- Three modules that had no test have one: the rename path, the OIDC
  middleware, and the automatic-fallback half of the chunked upload gate. With
  them, every defect and every fragility the code review found is closed.

## v3.1.1 (2026-09-01)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.1.1)

### The text editor no longer writes files it will refuse to reopen

Two settings govern the inline editor and nothing tied them together.
`EDITOR_MAX_FILESIZE` decides what it will open; `MAX_JSON_BODY_SIZE` decides
how much can be sent back, because saving carries the whole file in a JSON
request body.

Saving checked neither. Open a small file, paste two megabytes into it, save —
accepted and written — and the next attempt to open it answered _This file is
too large to open in the text editor_. A file the editor had written and would
not take back.

Raising `EDITOR_MAX_FILESIZE` on its own, which [the FAQ](../reference/faq.md)
recommended for editing larger documents, produced the other half:
the file opened, and saving answered _request entity too large_ — a message
naming neither of the two settings involved. It is the failure reported
upstream as [nxzai#368](https://github.com/nxzai/NextExplorer/issues/368).

The pair is now one decision:

- **Where no body ceiling has been set**, it rises to carry whatever the editor
  opens, twice over — JSON escaping can double the text, every quote and
  newline becoming two characters.
- **Where one has been set**, it is kept. A ceiling someone chose is a guard,
  not a detail to be talked out of, so the editor is lowered to what that
  ceiling can carry instead, with a warning naming both values.

Either way the editor cannot open a file it would not be able to save, and
saving refuses what it could not reopen. A request that really is too large now
says which setting governs it.

### Every navigation reported an error it had recovered from

Moving between folders left `Uncaught (in promise) InvalidStateError:
Transition was aborted because of invalid state` in the browser console, on
every navigation. Nothing was wrong — the view transition simply did not get to
animate, and the promise that says so had no listener. It is now observed, while
the two promises that would carry a genuine failure are deliberately left to
surface.

### Also

- A release no longer rebuilds the images a push to `main` has just built. It
  checks that its tag and the manifests agree, which takes seconds instead of
  two multi-architecture builds.
- The image build itself lives in one place instead of being written out once
  per channel — the duplication that had let a version tag exist for one
  variant and not the other.
- The documentation site is redeployed when documentation changes, rather than
  on every push.

## v3.1.0 (2026-08-29)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.1.0)

### Changing a share's password now ends the access it replaces

Rotating the password on a share is what an owner does when a link has leaked.
It protected nothing until now: a guest session is created the moment someone
gets in, lasts a day, and was never looked at again — so everyone already
inside stayed inside, with the old password, for up to twenty-four hours after
it had been changed.

Setting or replacing a password now revokes the sessions of that share, and
only that share. Removing a password does not: taking the lock off opens the
share to everyone, and throwing out the people currently reading it would be a
surprise rather than a protection.

### OIDC group membership is read at every sign-in

::: warning Read this before upgrading if you use `OIDC_ADMIN_GROUPS`
Group membership used to be read once, when the account was first created.
Someone added to the admin group afterwards never became an administrator, and
— the half that matters — someone **removed** from it stayed one. The
documentation said membership was re-evaluated at each login. It was not.

It is now, in both directions, and each change of role is logged. If your
provider's group claim is out of date, or narrower than you think, the roles it
carries will now be applied.
:::

Two conditions have to hold before the provider is allowed to decide anything.
`OIDC_ADMIN_GROUPS` must be configured — without it every login derives the
plain `user` role, and applying that would demote the administrator promoted
from Settings, or created by `AUTH_ADMIN_EMAIL`, at their next sign-in and
leave nobody able to administer the instance. And the provider must actually
have returned a group claim: a missing `groups` scope looks exactly like a user
who belongs to nothing, and its documented symptom is "not an admin after
login", so acting on that silence would turn a misconfiguration into a
demotion.

If an instance does lock itself out regardless, `AUTH_ADMIN_EMAIL` still
promotes an account at startup.

### Copying to a dataset that refuses a chmod

Preserving a file's permissions means a `chmod` on the copy, and some
filesystems refuse one: a ZFS dataset with `aclmode=restricted`, where new
files must inherit the directory's ACL untouched, fails the copy outright
rather than the permission change ([#2](https://github.com/cerede2000/NextExplorer/issues/2)).

A copy still preserves permissions by default; where the destination refuses,
it is retried without preserving them instead of failing. `COPY_PRESERVE_PERMISSIONS=false`
skips the attempt altogether, for a deployment where it is always refused.

### Uploads: what a killed one leaves, and one that cannot fit

A direct upload writes to `<name>.uploading` and renames on success. Every
failure it could observe was cleaned up, but nothing survived the process being
killed: a restart mid-upload left `holiday.mp4.uploading` in the folder, in the
listing, with nothing anywhere that would remove it. The artifact now joins
`.download` in the hidden-file defaults, and the destination folder is swept of
the ones nothing has written to for a day.

`UPLOAD_STORAGE_RESERVE` was enforced only on the chunked upload path, which is
off by default — so the free-space guard covered the path a deployment opts
into and missed the one it gets. Both paths now refuse an upload the volume
cannot hold, with a `507`. What that protects is not the upload: where
`/config` shares the filesystem, a full disk stops SQLite being able to write,
and the application stops working for everyone rather than for whoever was
uploading.

### A favourite whose volume is not there

Remove a volume from the compose file and the rows pointing into it survive.
The favourite stayed in the sidebar looking perfectly ordinary and answered
with a 404 when clicked.

Such favourites are now shown as unavailable, and startup reports what points
at a volume that is not there — favourites, shares, recent destinations and
folder preferences, counted per volume. **Nothing is removed.** A volume that
is absent is not a volume that is gone: an NFS mount may not be ready yet, an
external disk may be unplugged for a weekend, a compose line may be mistyped
and corrected a minute later. Only a person can tell those from a volume that
is never coming back.

### Markdown opens in the editor, when asked

A per-user setting, off by default, for opening `.md` files straight in the
text editor rather than in the preview. It is the first row of what should
become a table of per-user rules for which application opens which extension.

### Also

- A [full review of the codebase](https://github.com/cerede2000/NextExplorer/blob/main/REVIEW.md)
  — ten lots, some 67,000 lines — is published, defects and fragilities named
  and located. Four of its five defects are fixed in this release; the fifth
  needs a decision rather than a correction and is written up with its options.
- The default upload path, which had no test of any kind, has three.
- User preferences are declared in one table instead of being spelled out in
  three places, which is why a saved Markdown preference used to revert.
- Every push to the integration branch publishes `test` and `test-lean` images,
  so a change can be tried before it reaches `latest`.

## v3.0.2 (2026-08-28)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.0.2)

### Chunked uploads no longer take the server down

Where `UPLOAD_CHUNKED_ENABLED` was on, every upload by a signed-in user killed
the process. The browser reported a lost connection and a 502; the container
restarted; and on a deployment whose storage is not persistent, it came back
with an empty database — favourites, shares and preferences gone with it.

The upload server finishes its responses with `res.end(callback)`, a form Node
accepts. `express-session` replaces `res.end` with a two-argument version that
reads that callback as a body and passes it to `res.write()`, which throws where
nothing catches it. Because the session store implements `touch`, an established
session took that path on every request — so the failure was systematic rather
than occasional.

### A poll that never stopped

The client watched for document-editing activity on every navigation, whether or
not a document server was configured. Where ONLYOFFICE is not set up the
endpoint does not exist, so each poll returned 404, was retried a second later,
and was logged server-side with a full stack trace — for as long as a tab stayed
open. It now waits for the feature flags and starts only where there is
something to watch.

### A demo you can walk into

With `DEMO_MODE` enabled and demo credentials configured, the sign-in form
arrives filled in and there is only the button to press. Serving a password to
whoever loads a page is right for a demo and wrong everywhere else, so it takes
demo mode _and_ both halves of a credential named for the purpose; the variables
are separate from the admin bootstrap ones, so nothing set for another reason
can publish a password. `DEMO_SAMPLES=false` keeps demo mode without the 81 MiB
sample archive, which is worth having where storage is not persistent and the
download would repeat at every restart.

### Images follow main

`latest` and `latest-lean` were built only when a release was cut, so a fix
waited for one. Every push to `main` now builds and publishes both variants to
GHCR and Docker Hub, each also tagged with the version in `package.json` —
`3.0.2` and `3.0.2-lean`. A release additionally refuses to publish if the tag
it was cut from disagrees with the manifests.

### Also

- [The HTTP API is documented](../reference/api.md), with examples run against
  the live demo: signing in, browsing, resumable uploads, sharing and deletion.
- The public demo has sharing enabled, folder sizes in full mode with the usage
  bar, and a `PUBLIC_URL` that is actually parsed — it was previously a bare
  hostname, which `new URL()` rejects, leaving the instance with no canonical
  URL.

## v3.0.1 (2026-08-27)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.0.1)

### What a folder leaves behind

Rows that pointed at a path did not follow it. A favorite outlived the folder it
named, a share kept pointing at a path that no longer existed, and a folder's
sort order was inherited by whatever folder was created there next. Deleting
cleaned up the favorites of whoever pressed delete and nobody else's — which
made it a bug rather than an omission, since those are other people's rows.

Favorites, shares, recent destinations and per-folder preferences now follow a
folder when it is renamed or moved, and are forgotten when it is deleted, for
every user who had them. Everything inside the folder comes along too. A copy
leaves the original's bindings where they are.

### Per-folder preferences without a ceiling

Sorting and view mode were kept as one JSON document per user, rewritten whole
on every change and shipped entire on every load. It had to be capped, so the
hundred-and-first folder silently forgot the oldest — and a document cannot be
cleaned up when a folder disappears.

They are rows now: no cap, no silent forgetting, and they can be maintained.
Existing preferences are carried over on first start.

### Also

- The view a folder opens in is remembered per folder and per user, with a
  default in Settings → User preferences ([#360](https://github.com/nxzai/NextExplorer/issues/360)).
- Per-folder sorting, contributed by [@jimaek](https://github.com/jimaek)
  ([#356](https://github.com/nxzai/NextExplorer/pull/356)), reworked after review to store per user.
- `npm run version:set` sets the version in every manifest at once, and CI fails
  if they disagree.

## v3.0.0 (2026-08-27)

[GitHub release](https://github.com/cerede2000/NextExplorer/releases/tag/v3.0.0)

First release of this fork. It gathers the work done since the upstream
repository went quiet in July 2026, and the version is bumped to 3.0.0 to make
clear that this is a different line of development — not an upstream release.

### Uploads

- Chunked, resumable uploads (TUS), with automatic fallback when a reverse proxy
  refuses a large body, and a per-origin chunk size that is learned rather than
  guessed.
- Transfer rate shown while anything is moving, measured over a trailing window
  so it reflects the speed you actually have.
- The final server-side copy is reported separately, instead of a progress bar
  that appeared to freeze at 100% for the length of it.
- Empty files and folders containing them upload correctly.
- Dropped files keep their own names.

### Files

- **Move to** and **Copy to** from the context menu, offering recent
  destinations and favorites before any browsing — the only route to a transfer
  on a touch device, where dragging is unavailable.
- Native, cancellable copy and move with real progress, and the view repositions
  on what was just transferred.
- Copy by drag-and-drop onto folders and favorites (Alt/Option), and per-folder
  sorting that is remembered.
- Recursive folder sizes and volume usage indicators.
- Large directories and bulk deletion handled without stalling the interface.
- Keyboard navigation through folders.

### Media

- One gallery for pictures and videos, navigable by swipe, arrow keys or
  on-screen arrows.
- Pinch, double-tap and ctrl-wheel zoom, with dragging that pans a zoomed
  picture and turns the page otherwise.
- Portrait videos can be closed again on Android.

### Documents

- ONLYOFFICE: reliable background autosave, shared editing sessions, the
  editor's own close button, rename and save-as from the editor, mentions,
  comparison, insertion from the user's own storage, and the app's theme.
- New blank Word, Excel and PowerPoint documents from a drawer beside New file.
- Secure shared text editor with granular write controls.

### Access and security

- Per-user access control, personal folders and user volumes.
- OIDC sessions persisted in SQLite, and the configured origin preserved across
  authentication.
- Every credential can be read from a file via a `_FILE` variable, keeping
  secrets out of `docker inspect`.
- Public share activity tracking, clean direct share URLs, and hidden-file
  visibility honoured by download artifacts.

### Under the hood

- Container dependencies refreshed; optional VA-API and RAW support through
  build arguments, and a lean image without them.
- Thumbnail queue and cache stabilised, with prefetching only while idle.
- Translations completed across all 13 locales.
- Test suites repaired and considerably extended.

**Contributors**: [@jimaek](https://github.com/jimaek) (per-folder sorting,
media gallery and swiping).

## v2.0.7 (2025-12-23)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.7)

### What's Changed

#### New Features

- added option to choose color-scheme in editor
  ![Editor Theme Selection](/images/editor-theme-1.png)

#### Bugfixes

- OIDC error redirects to login screen
- teminal menu style fix
- loading indicator style fix

- context menu hide unrelated options based on readonly/shared path

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.6...v2.0.7

## v2.0.6 (2025-12-20)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.6)

### What's Changed

- added demo url
- added OIDC_AUTO_CREATE_USERS option
- share option in context menu
- home button in mobile view

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.5...v2.0.6

## v2.0.5 (2025-12-19)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.5)

### What's Changed

- Updated login page layout, language selection now on top right
- Added option to resize columns and sort by column header on detail view
- Added keyboard shortcuts and confirm on close on default text editor.
- Various UI fixes

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.4...v2.0.5

## v2.0.4 (2025-12-18)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.4)

### What's Changed

- admin username/password in env ( skips setup ) AUTH_USER_EMAIL and AUTH_USER_PASSWORD
- fix dark mode for iOS and the scrolling in mobile.
- added system color scheme ( auto mode )
- various UI fixes
- fix thumbnail orientation

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.3...v2.0.4

## v2.0.3 (2025-12-17)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.3)

### What's Changed

- terminal menu color in light mode
- add volumes features for users (USER_VOLUMES)
- removed unnecessary chown on /app
- dockerfile and healthcheck fixes now uses nodejs without curl dependencies
- ellipsis fix and file thumbnail overflow fix
- updated breadcrumb
- show message for folder when empty
- folder views more responsive UI fixes
- added swedish language support
- refactor i18n
- date validation added for share dialog
- fixing guest session overriding user session
- added documentation for user volumes feature
- added ghcr.io image

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.2...v2.0.3

## v2.0.2 (2025-12-09)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.2)

### What's Changed

- open with editor option for any file
- download on context menu
- docker health check
- fix for file rename mouse select
- responsive ellipsis on detail view
- added avatar url from token + user claims
- SKIP_HOME env var takes user to first volume

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.1...v2.0.2

## v2.0.1 (2025-12-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.1)

### What's Changed

- fix download failing from share
- fix downloading dotfiles
- shared files now show thumbnails
- retouched Ui of share view

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v2.0.0...v2.0.1

## v2.0.0 (2025-12-03)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v2.0.0)

### What's Changed

#### File Sharing System

- Added complete file sharing functionality with share links
- New "Shared by Me" view to manage outgoing shares
- New "Shared with Me" view to access incoming shares
- Share dialog with permissions management
- Guest session support for anonymous access
- Share link creation and management with expiration options
- Access control for shared resources

#### Personal Directories

- Added user personal directory feature
- Individual user storage spaces with proper isolation

#### Architecture & Refactoring

- Reorganized backend codebase into src/ folder structure
- Improved code organization and modularity
- Enhanced middleware architecture
- New services: sharesService.js, guestSessionService.js, accessManager.js
- Refactored authentication middleware with better access control

#### UI/UX Improvements

- Redesigned authentication screen with better UI
- Updated home view with new icon styling
- Enhanced directory icon rendering
- Improved folder view toolbar with share actions
- Fixed image preview loading flicker
- Added toolbar separator for better visual organization
- Responsive design improvements
- Better breadcrumb navigation with share context

#### Internationalization

- Refactored translation system
- Updated all language files (EN, DE, ES, FR, HI, PL, ZH)
- Improved translation structure and consistency

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.2.4...v2.0.0

## v1.2.4 (2025-11-26)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.2.4)

### What's Changed

- i18n polish language support #108
- Tailwind v4
- UI theme simplified
- drag rectangle to select items
- faster file listing, thumbnail generation in queue, concurrent thumbnail job configuration #117
- heif file thumbnail preview
- fix [downloading directory with Cyrillic characters #122
- manage iles and folder permissions from info panel #

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.2.3...v1.2.4

## v1.2.3 (2025-11-18)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.2.3)

### What's Changed

- thumbnail errors are fixed. now if the thumbnail cannot be generated, it sends the original file for preview
- centralized error handler on backend, and created a notification system which shows all errors on frontend as notification
- improved re-ordering of favourites using vuedraggable and sortable.js
- added integrated terminal available only to admins

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.2.2...v1.2.3

## v1.2.2 (2025-11-18)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.2.2)

### What's Changed

- Favourites when AUTH_ENABLED=false
- persist sessions across server restarts
- scrollbar on left menu
- disable +Create New button on Volume view

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.2.1...v1.2.2

## v1.2.1 (2025-11-16)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.2.1)

### What's Changed

- favorites can be customized now, user can choose name, color, style and reorder them too.

## BREAKING

all existing favorites will be assigned to the first user since the existing favorites were not user specific

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.2.0...v1.2.1

## v1.2.0 (2025-11-16)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.2.0)

### What's Changed

#### added OIDC_REQUIRE_EMAIL_VERIFIED flag

optional and by default set to 'false' if user wants to integrate OIDC with verified emails only they can set it to 'true'.

#### Skip setup if auth mode set to oidc

previously if its a fresh start with OIDC integration with only OIDC mode, it still used to ask to create an admin user. now it just shows the OIDC login button

#### faster download and cleaned up upload service

it was using js fetch which used to download the files in memory until completed and then used to download it to user's system. Now using native file download which instantly downloads the files.

#### EDITOR_EXTENSIONS env added

this env flag supports comma separated extensions names which you want to open with default built in editor.
keep in mind that the ONLYOFFICE_FILE_EXTENSIONS take priority over this list. so if you have html in EDITOR_EXTENSIONS and in ONLYOFFICE_FILE_EXTENSIONS both, it will open with OnlyOffice.

#### Added "New File" option in the create menu.

it was difficult to create new files if the folder is full and has no empty space to click on the background. adding this button makes it simpler

#### Various bugfixes

drive icon was not respecting app color scheme.
improvement and optimization on uploadService

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.9...v1.2.0

## v1.1.9a (2025-11-15)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.9a)

### What's Changed

- faster download and cleaned up upload service by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/93

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.9b...v1.1.9a

## v1.1.9b (2025-11-14)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.9b)

### What's Changed

- added OIDC_REQUIRE_EMAIL_VERIFIED flag by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/91
- skip setup if auth mode set to oidc by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/92

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.9...v1.1.9b

## v1.1.9 (2025-11-14)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.9)

### What's Changed

- docs updated
- improved search performance and bug fixes
- AUTH_MODE added
- version bump

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.8...v1.1.9

## v1.1.8 (2025-11-13)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.8)

### What's Changed

#### Refactored authentication

- username -> email. now users login by email. its done to simplify linking of OIDC with local accounts and create users with custom access in future
- existing users will get "example.local" suffix that can be changed from admin menu
- added option to edit existing users

#### Improved Search

- spotlight like search for looking up files and folders.
- it also searches inside text files and highlights matching texts

#### new UI

- some UI tweaks

#### Vitepress documentations

- docs are migrated to vittepress. Work in progress to update the docs

#### multi language support

- added i18n support for various language. new language requests can be created in github issues

#### AUTH_ENABLED=false to remove auth completely

- now users can remove the entire auth module by this docker flag.

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.7...v1.1.8

## v1.1.7 (2025-11-10)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.7)

### What's Changed

- The image preview now supports previous and next option

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.6...v1.1.7

## v1.1.6 (2025-11-10)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.6)

### What's Changed

- Refactoring API for better scalability and DX
- refactored plugin architecture
- fixed onlyoffice plugin issues
- small UI tweaks

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.5...v1.1.6

## v1.1.5 (2025-11-09)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.5)

### What's Changed

- reverting multi image carousel in image preview because of bugs

## v1.1.4 (2025-11-08)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.4)

### What's Changed

- fixed openoffice initialization issue if /features fails without auth by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/69
- version bump and readme updated by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/70

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.3...v1.1.4

## v1.1.3 (2025-11-08)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.3)

### What's Changed

- added next prev option to image preview lightbox
- added ONLYOFFICE_LANG env for setting language on onlyoffice
- ONLYOFFICE_FILE_EXTENSIONS to specify custom list of file. Any extension mentioned here will take higher priority then default viewer/editor

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.2...v1.1.3

## v1.1.2 (2025-11-06)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.2)

### What's Changed

- drag and drop support
- leaner session and bugfixes
- Refactor: centralize file actions
- keyboard shortcuts
- onlyoffice integration

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.1...v1.1.2

## v1.1.1 (2025-11-05)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.1)

### What's Changed

- OpenID Compliant claims fetching using userinfo callback
- OIDC_USERINFO_URL parameter for custom userinfo endpoints
- Added detailed debug logging throughout the application for better traceability.
- Updated express-openid-connect dependency to version 2.19.2.
- Introduced userinfo URL override in oidcService for more flexible user info fetching.
- Configured Docker environment for debug logging.
- allow spaces in admin groups, if user provides comma separated values
- view mode picture added to show picture gallery
- info panel to display additional information about file/folder/images

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.1.0...v1.1.1

## v1.1.0 — local user management, logging and OIDC fixes (2025-11-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.1.0)

### What's Changed

- Added mkdocs hosted at explorer.nxz.ai
- used sqlite db for user persistance
- using express-openid-connect by auth0 for integration with OIDC providers.
- Centralized version management
- Admin can now create, delete and manage local users from UI
- about screen shows git commit hash
- local user can reset their passwords

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.0.7...v1.1.0

## v1.0.7 — enhancements and bug fixes (2025-11-01)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.7)

- added OIDC support for multi-user
- added user menu in the sidebar
- added tooltips to icons
- added public url for proxies, preparation for file sharing
- sidebar now resizable
- search in the current directory for files and content inside files as well using ripgrep
- added right-click context menu for file actions
- new file creation option in context menu
- responsive sidebar, breadcrumb and view mode options
- syntax highlighting for editor
- new folder option added to context menu as well

## v1.0.6 — Enhancements (2025-11-01)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.6)

### What's Changed

- added OIDC support for multi-user
- added user menu in the sidebar
- added tooltips to icons
- added public url for proxies, preparation for file sharing
- sidebar now resizable
- search in the current directory for files and content inside files as well using ripgrep
- added right-click context menu for file actions
- new file creation option in context menu
- responsive sidebar, breadcrumb and view mode options
- syntax highlighting for editor
- new folder option added to context menu as well

## v1.0.5 (2025-10-15)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.5)

### What's Changed

- settings screen which allows user to turn on or off the thumbnail generation
- option to disable/enable authentication
- support PGID and PUID just like linuxserver.io images
- added option to show the release version in the app.

## v1.0.4 (2025-10-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.4)

### What's Changed

- added docker hub overview
- simplified CI pipeline

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.0.3...v1.0.4

## v1.0.3 (2025-10-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.3)

### What's Changed

- add arm support by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/22

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.0.2...v1.0.3

## v1.0.2 (2025-10-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.2)

### What's Changed

- force favicon refresh by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/20

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.0.1...v1.0.2

## v1.0.1 (2025-10-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.1)

### What's Changed

- updated image name correctly by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/19

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/compare/v1.0.0...v1.0.1

## v1.0.0 (2025-10-04)

[GitHub release](https://github.com/vikramsoni2/nextExplorer/releases/tag/v1.0.0)

### What's Changed

- Auth by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/1
- fixes by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/2
- file preview as plugin by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/3
- file icon fix by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/4
- favicons updated and better docker build setup by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/17
- docker build automation by @vikramsoni2 in https://github.com/vikramsoni2/nextExplorer/pull/18

### New Contributors

- @vikramsoni2 made their first contribution in https://github.com/vikramsoni2/nextExplorer/pull/1

**Full Changelog**: https://github.com/vikramsoni2/nextExplorer/commits/v1.0.0
