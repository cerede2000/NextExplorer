# Changelog

Release notes for NextExplorer. GitHub remains the source of truth: https://github.com/cerede2000/NextExplorer/releases

Releases up to v2.0.7 were made upstream, at https://github.com/vikramsoni2/nextExplorer/releases.

Releases are listed newest to oldest.

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
