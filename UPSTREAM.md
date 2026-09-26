# Upstream

How the work in this fork reaches `nxzai/NextExplorer`, what is left, and how
the remaining subjects are cut so that the plan published in nxzai#373 closes at
thirty-three and not at forty.

## Where this stands

| Batches | State                                                               |
| ------- | ------------------------------------------------------------------- |
| 1–9     | Merged 9 September 2026 (nxzai#374–#385).                           |
| 10–20   | Merged 25 September 2026 (nxzai#396–#406).                          |
| 21–27   | Merged 26 September 2026 (nxzai#410–#416).                          |
| 28–33   | Merged 26 September 2026 (nxzai#417–#430), 33 split into 33.1–33.4. |
| Delta   | Merged 26 September 2026 (nxzai#431, #432). See "What is left".     |

**The plan of nxzai#373 is closed.** Every one of its subjects is on `main`
upstream, and so are the two that followed it: the volume guard this fork had and
upstream did not (nxzai#409), and the file routes, the shared editor and the
editor's storage picker that closed the last of the API surface.

**A second phase is open.** The plan closed on a route count, which is the wrong
instrument: a route counts capability that arrives as a route, and says nothing
about a service with no route of its own, a defect in a shared value, or a screen
missing for a route that landed. A file-level measurement of both trees, made 26
September 2026 after the last merge, found 401 files differing outside the tests,
and among them capabilities and defects the route count could not see. Those are
the second phase; the list is under "What the route count missed".

## How the count closes

One subject, one number. The rule that keeps the total honest:

- **A batch that proves too large is split into several pull requests under the
  same number** — never into a new number. Batch 26 is the worked example: #415
  carries the server half (a text save that keeps what it replaced, and a
  history that can be read), and the panel that shows that history follows under
  the same 26. The numbering describes the plan, not the delivery.
- **Nothing discovered on the way gets a number.** A defect found while porting
  is fixed inside the batch that owns the file, and named in that batch's pull
  request. Four of the seven open ones carry such a fix: a document emptied by a
  download that never finished, a text file written over directly, a symbolic
  link rewritten to point at the source tree, and a share counting page loads as
  downloads.
- **Each batch carries its own strings and its own documentation.** The
  catalogues are not a batch: a screen arrives with the fifteen languages it
  needs, or it arrives untranslated and no batch can be said to be finished.
- **What a batch cannot take, it names.** Each pull request says what it left
  behind and which batch will carry it, so the remainder is always written
  down somewhere other than in somebody's head. The current list is at the end
  of this file.
- **What is not in the list is stated as not in the list**, rather than waiting
  to become batch 34.

## What is left

The route surface is level: **upstream mounts every route this fork does, bar
one.** `GET /api/files/recent-destinations` serves the destination dialog, which
is below among the things nxzai#373 never claimed.

What follows is what a route count cannot reach.

## What the route count missed

Measured 26 September 2026 by diffing `origin/main` against `integration` file by
file, and by diffing the function names inside the files both trees have. 401
files differ outside the tests: 118 only here, 22 only upstream, 261 in both.
Sorted by what the difference is, because only the first two groups are work.

### Defects of upstream's own, that this fork does not have

|                                | Upstream today                                                                                                                  | Reversed  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| The session secret             | `randomBytes(32)` per start, twice over — a restart signs everyone out, and the ONLYOFFICE and thumbnail secrets change with it | nxzai#434 |
| A rejection nobody listens to  | no `unhandledRejection` handler in `backend/src` — one missed `await` stops the server                                          | nxzai#435 |
| Sixteen translation keys       | eight screens render their own keys, the About page's whole tools section among them                                            | nxzai#433 |
| `createFile` in the file store | reads `created?.name` where the route returns `{ item }` — a second untitled file opens the rename box on the first             |           |
| `createOfficeDocument`         | in the API layer with no caller: the route nxzai#432 landed cannot be reached from any screen                                   |           |
| The OIDC return origin         | a fixed `baseURL`, so behind a proxy the post-login return points elsewhere                                                     |           |
| OIDC availability              | nothing distinguishes "not configured" from "configured and unreachable"                                                        |           |
| The branding logo              | written over `custom-logo.png` in place, with no way back                                                                       |           |
| `Range` parsing                | two copies, and they do not agree on the headers                                                                                |           |
| EXIF                           | still `exifr`, unpublished since 2022                                                                                           |           |

### Capabilities this fork has and upstream does not

Backend: switching the search index and the folder sizes on from the settings
rather than from a variable · the size index updated by the write instead of by
the periodic sweep · the rows that point at a volume that was removed · the
start-up notice for what releases up to 1.1.7 left in the cache · the periodic
performance record · recent destinations · per-folder sort and view · the
prepared-statement cache · and the transfer engine, which is 48 functions here
against 14 there: cancelling a running copy, its progress, native `rm`, staging,
permissions, diagnostics.

Frontend: a session that expires while nobody is navigating · the three
navigation guards · per-folder preference and scroll position · concurrent
operations and their progress · volume usage · the destination dialog · inline
quick actions · the code surface · the new-document dialog · the share list
toolbar and its empty states · eleven utilities · six upload composables.

### Shape, not capability

The file store split into nine modules, the rewritten folder view, the context
menu — nxzai#373 placed these outside the thirty-three and they stay outside it.
Prose rewritten and functions restructured after a batch had already gone over
belongs here too.

### Ours, and staying ours

The release workflows and `packaging/`, the demo and `render.yaml`, the image
pruning scripts, this file and the two beside it.

One exception worth offering: `eslint.config.mjs`. `npm run lint` on upstream
reports 143 errors, 141 of them the same parse error on its own test files,
because `.eslintrc.cjs` does not declare `backend/tests/**` as modules.

## What is not in the thirty-three

Stated so the count closes:

- **The standalone archive and its packaging** — `packaging/install.sh`,
  `assemble.sh`, the release workflows, the image pruning scripts. A fork
  concern; upstream publishes images only.
- **This fork's own interface architecture** — the file store split into
  modules, the rewritten folder view, the quick actions, the clipboard progress
  panel, the destination dialog and the operations store. Where upstream's
  equivalent works, it stays as it is; the pieces a batch genuinely needs travel
  with that batch and nothing more. #416 is the example: the trash screen went
  over without the destination dialog, so restoring puts an item back where it
  came from and choosing another folder waits for the batch that brings the
  dialog.
- **Anything found from here on.** It is fixed inside the batch that owns the
  file, or it is written down here as out.

The second phase adds one rule, learned from how this list was found: **a claim
of parity names the instrument that measured it.** "Upstream mounts every route
this fork does" was true and was read as "upstream does everything this fork
does", which was not. The two are a file-level diff apart.

## Left behind so far, and by whom

Everything this table held has landed. What is left is the list above: the
destination dialog and its route, and the interface architecture below.

| Piece                                         | Left by    | Landed in                   |
| --------------------------------------------- | ---------- | --------------------------- |
| Reading a version as text                     | #415       | #417                        |
| Reading the text of a file still in the trash | #415, #416 | #417                        |
| Telling an open document it was restored      | #415       | #418–#421                   |
| ONLYOFFICE keys, sessions, Save as, mentions  | #410       | #418–#421                   |
| The resumable upload protocol                 | #413       | #422                        |
| The purge entry in the activity log           | #415       | #428                        |
| Restoring into a chosen folder                | #416       | still here, with the dialog |
| Progress and cancellation for a running copy  | #412       | still here, with the dialog |

## The gates every batch passes

Unchanged since batch 10, and stated in each pull request:

1. The changed files pass lint and formatting — with the errors already present
   on `origin/main` subtracted, not silenced.
2. `npm run build`, and every backend module loads. These are the two steps
   upstream's CI runs, so a batch that fails them fails in public.
3. The whole backend suite, compared against what `origin/main` gives on its
   own. Measure that baseline rather than trusting a note: on a full run `main`
   fails `auth.test.js` ("current password is incorrect") and
   `browse-hidden-files.test.js` every time, and `users.test.js` (lockout) and
   `userSearchService.test.js` (limit) under load — those two pass when run
   alone, before and after any of this. Nothing new fails, and the count of
   tests goes up.
4. Every claim has a test that fails when the change behind it is put back. A
   test that passes for the wrong reason counts as no test: two refusals in
   batch 21 were rewritten after mutation showed the network was doing the
   refusing.
5. **For a batch that is mostly screens, the image is the gate.** Upstream runs
   no frontend test suite, so there is nothing to add a unit test to: build the
   image, start it, and drive the screen in a browser — #416 was checked by
   deleting a file, finding it in the trash with its provenance, restoring it
   from the screen and watching the folder get it back.

## Order

26's second half and 28 first: they finish what is already merged or about to
be — a history nobody can see, and office documents whose second save is not yet
correct. Then 29, 30, 31 in whichever order review allows; they touch nothing
each other needs. 32 stands alone. 33 last, split, because it is the widest and
the least entangled with the rest.
