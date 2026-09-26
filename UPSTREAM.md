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

`scripts/parity.mjs` measures it, and `scripts/parity-manifest.json` accounts for
it. Run it:

```
node scripts/parity.mjs --upstream origin/main --ours HEAD
```

Eight axes, because a route count only sees capability that arrives as a route:
files on either side, routes, symbols inside files both trees have, files whose
symbols match but whose bodies have drifted, documentation pages, translation
keys, environment variables, and database migrations.

Every finding must match a rule in the manifest — **OURS**, **SHAPE**, **PORT** or
**DONE** — and a finding nobody has classified makes the script exit 1. It runs in
CI on every push, so a divergence introduced from here on has to be spoken for
before it can be merged. That is the whole mechanism, and it exists because a
count nobody re-runs is exactly how three batches were declared delivered while
short.

As measured 26 September 2026, after nxzai#432:

| Verdict      | Findings |                                                                                                                          |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| OURS         | 447      | our workflows, packaging, demo, test wiring, planning documents, and the quick-actions menu upstream closed in nxzai#333 |
| SHAPE        | 132      | the file store split into modules, the rewritten folder view — placed outside the plan by nxzai#373                      |
| DONE         | 3        | reversed in nxzai#434, #435, #436                                                                                        |
| PORT         | 1411     | the 33 batches below                                                                                                     |
| unclassified | 0        |                                                                                                                          |

### Three of the published thirty-three were short

The list in nxzai#373's phase-2 comment is the one the maintainer read. Three of
its entries were not delivered in full, and the numbering drifting from that list
after batch 23 is how it went unnoticed — the activity log shipped as "33.2" where
the published list has it at 28, so its tail no longer lined up with anything.

| Published | Promised                                                        | Delivered                                | Missing                                    |
| --------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| 23        | Native copy/move **with progress and cancellation**             | nxzai#412: rsync, and links that survive | progress and cancellation — batch 49 below |
| 31        | Search: names from the index, ranking, **switches in Settings** | nxzai#427: names from the catalogue      | the switches — batch 42 below              |
| 33        | The locale catalogues, **with the key-parity test**             | the catalogues are at parity upstream    | the test that holds them there — nxzai#433 |

The deferred table further down had recorded the first of those. This file said the
plan was closed on the same page that said the copy's progress was still here.

### The batches

| 38 | OIDC behind a proxy, and which of two failures it was | 36 |
| 39 | a logo that can be changed back | 18 |
| 40 | one Range parser, not two that disagree | 10 |
| 41 | EXIF without a parser nobody maintains | 13 |
| 42 | the switches in Settings — the remainder of published batch 31 | 32 |
| 43 | the size index kept current by the write, not by the sweep | 15 |
| 44 | the rows that point at a path that is gone | 11 |
| 44/47/50 | the schema the batches below add; each migration travels with the feature that needs it | 5 |
| 45 | what releases up to 1.1.7 left in the cache | 1 |
| 46 | the periodic performance record | 7 |
| 47 | sort and view remembered per folder | 172 |
| 48 | one database handle, and its prepared statements | 24 |
| 49 | a copy that reports and can be stopped — the remainder of published batch 23 | 195 |
| 50 | the destination dialog, and the folders somebody actually files into | 23 |
| 51 | bounds on browsing inside an archive | 11 |
| 52 | the chunked fallback, and the switch that governs it | 55 |
| 53 | two ceilings nobody could raise | 3 |
| 54 | a session that ends while nobody is navigating | 23 |
| 55 | the navigation guards, each a function of its inputs | 27 |
| 56 | how full a volume is | 16 |
| 57 | the list of shares, seen | 91 |
| 58 | finding a name in a folder nobody can scroll | 29 |
| 59 | the documentation the delivered batches left behind | 11 |
| 60 | the trash and the versions panel, their remainder | 42 |
| 61 | access rules and what they hold | 40 |
| 62 | the accounts screens | 18 |
| 63 | ONLYOFFICE and Collabora, their remainder | 116 |
| 64 | the context menu, and saying what a deletion will do | 88 |
| 65 | what a file looks like in the list | 55 |
| 66 | the Markdown preview | 37 |
| 67 | what the terminal does with what is typed | 3 |
| 68 | strings whose screens are covered by the batches above | 182 |
| 69 | the OpenAPI description follows every route these batches add; it goes last, when there is nothing left to describe | 2 |

Batch 69 goes last: the OpenAPI description follows the routes, so there is nothing
to describe until the rest has landed.

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

The second phase adds two rules, learned from how this list was found.

**A claim of parity names the instrument that measured it.** "Upstream mounts
every route this fork does" was true and was read as "upstream does everything this
fork does", which was not.

**A batch is delivered when its published description is delivered, not when its
number is merged.** Three were closed short. The remedy is not more care: it is
`scripts/parity.mjs`, which does not forget and does not round up.

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
