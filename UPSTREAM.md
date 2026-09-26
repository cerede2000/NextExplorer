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

**Eleven axes**, because a route count only sees capability that arrives as a route:
files on either side · routes · symbols inside files both trees have · files whose
bodies differ at all · documentation pages · translation keys, across every
catalogue and not only English · environment variables · database migrations ·
dependencies, per manifest and per package · how the image is built · and the
coverage of the ten above.

That last one is the important one. It reports **any file that differs and that no
other axis spoke for**, which is what makes a missing axis visible. The first
version of this had seven axes and a thirty-line threshold below which it said
nothing, and 190 files sat outside it: the lockfile, the Dockerfile, the entrypoint,
every catalogue but English, and 93 source files that differed by less than thirty
lines. None of that was a judgement call — it was an instrument that did not know
what it could not see.

Every finding must match a rule in the manifest — **OURS**, **PORT** or **DONE** —
and a finding nobody has classified makes the script exit 1. It runs in CI on every
push, so a divergence introduced from here on has to be spoken for before it can be
merged.

As measured 26 September 2026, after nxzai#432:

|                        | Findings |
| ---------------------- | -------- |
| to reverse (PORT)      | 2132     |
| reversed (DONE)        | 3        |
| ours, and staying ours | 84       |
| unclassified           | 0        |

### Three of the published thirty-three were short

The list in nxzai#373's phase-2 comment is the one the maintainer read. Three of its
entries were not delivered in full, and the numbering drifting from that list after
batch 23 is how it went unnoticed — the activity log shipped as "33.2" where the
published list has it at 28.

| Published | Promised                                                        | Delivered                                | Missing                                    |
| --------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| 23        | Native copy/move **with progress and cancellation**             | nxzai#412: rsync, and links that survive | progress and cancellation — P3-06          |
| 31        | Search: names from the index, ranking, **switches in Settings** | nxzai#427: names from the catalogue      | the switches — P3-05                       |
| 33        | The locale catalogues, **with the key-parity test**             | the catalogues are at parity upstream    | the test that holds them there — nxzai#433 |

### The batches

Numbered **P3-nn**: phase 3, in delivery order. The thirty-three of nxzai#373 were
phase 2, delivered by 46 merged pull requests — a batch too large splits into
several under one number, and a defect found on the way takes a fix of its own.

Phase 3 is **44 batches**: four sent and waiting, **forty still to push**.

| Batch | Subject                                                                                                   | Findings        |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------- |
| P3-01 | the catalogue keys, and the parity test published batch 33 promised                                       | nxzai#433, open |
| P3-02 | the session secret, kept across a restart                                                                 | nxzai#434, open |
| P3-03 | a rejection nobody listened to, no longer fatal                                                           | nxzai#435, open |
| P3-04 | a document made from the menu                                                                             | nxzai#436, open |
|       | **Wave 1 — what the published thirty-three promised and did not get**                                     |                 |
| P3-05 | the switches in Settings                                                                                  | 35              |
| P3-06 | a copy that reports and can be stopped                                                                    | 195             |
| P3-07 | the documentation the delivered batches left behind                                                       | 11              |
|       | **Wave 2 — defects of upstream's own**                                                                    |                 |
| P3-08 | OIDC behind a proxy, and which of two failures it was                                                     | 44              |
| P3-09 | a logo that can be changed back                                                                           | 19              |
| P3-10 | one Range parser, not two that disagree                                                                   | 10              |
| P3-11 | EXIF without a parser nobody maintains                                                                    | 19              |
|       | **Wave 3 — backend capability with no screen of its own**                                                 |                 |
| P3-12 | the size index kept current by the write, not by the sweep                                                | 23              |
| P3-13 | the rows that point at a path that is gone                                                                | 13              |
| P3-14 | what releases up to 1.1.7 left in the cache                                                               | 1               |
| P3-15 | the periodic performance record                                                                           | 7               |
| P3-16 | one database handle, and its prepared statements                                                          | 26              |
| P3-17 | bounds on browsing inside an archive                                                                      | 17              |
| P3-18 | two ceilings nobody could raise                                                                           | 4               |
| P3-19 | the chunked fallback, and the switch that governs it                                                      | 58              |
|       | **Wave 4 — screens, and the stores behind them**                                                          |                 |
| P3-20 | sort and view remembered per folder                                                                       | 173             |
| P3-21 | the destination dialog, and the folders somebody actually files into                                      | 27              |
| P3-22 | a session that ends while nobody is navigating                                                            | 23              |
| P3-23 | the navigation guards, each a function of its inputs                                                      | 27              |
| P3-24 | how full a volume is                                                                                      | 16              |
| P3-25 | the list of shares, seen                                                                                  | 92              |
| P3-26 | finding a name in a folder nobody can scroll                                                              | 30              |
| P3-27 | the trash and the versions panel, their remainder                                                         | 49              |
| P3-28 | access rules and what they hold                                                                           | 46              |
| P3-29 | the accounts screens                                                                                      | 22              |
| P3-30 | ONLYOFFICE and Collabora, their remainder                                                                 | 125             |
| P3-31 | the context menu, and saying what a deletion will do                                                      | 90              |
| P3-32 | what a file looks like in the list                                                                        | 56              |
| P3-33 | the Markdown preview                                                                                      | 37              |
| P3-34 | what the terminal does with what is typed                                                                 | 4               |
|       | **Wave 5 — the strings, then the description that follows every route**                                   |                 |
| P3-35 | strings whose screens are covered by the batches above                                                    | 202             |
| P3-36 | the OpenAPI description follows every route these batches add; it goes last, when there is nothing left t | 6               |
|       | **Wave 6 — the shape. Outside nxzai#373's plan: offered, not owed**                                       |                 |
| P3-37 | the file store as nine modules rather than one file                                                       | 9               |
| P3-38 | the folder view as this fork writes it                                                                    | 101             |
| P3-39 | the HTTP layer and the helpers around it                                                                  | 22              |
| P3-40 | the editor's code surface, in place of useCodemirror.js                                                   | 1               |
|       | **Wave 7 — the runner, the lint configuration, the dependencies, the image**                              |                 |
| P3-41 | our frontend suites, and the runner they need                                                             | 190             |
| P3-42 | the lint configuration: upstream's own `npm run lint` reports 141 parse errors on its own test files beca | 6               |
| P3-43 | the dependency versions this fork runs                                                                    | 22              |
| P3-44 | the image as this fork builds it                                                                          | 6               |

Two things are not batches of their own. The five migrations (v20–v24) travel with
the feature that needs their table — P3-13, P3-20, P3-21. And 263 backend test
files travel with the batch that brings what they test, which is how every batch so
far was sent: upstream runs the backend suite, so a test of ours is portable.

### How this ends, and what it still will not be

It ends when `node scripts/parity.mjs` reports **0 PORT** — a condition a machine
checks. Each batch moves its own findings from PORT to DONE in the commit that sends
them, so the remainder is readable at any moment and only goes down.

What is left then is 84 findings, and none of it is capability: our release
workflows and packaging, the demo and `render.yaml`, our planning documents and
release notes, our own tooling, the ignore lists, the quick-actions menu upstream
closed in nxzai#333, and the files upstream has that this fork does not. `main`
upstream will do everything `integration` does, be written the same way, run the
same tests, install the same packages and build the same image. It will not carry
this fork's own scaffolding, and it should not.

Two things will move the total upward on their own, and are expected to: upstream
merging its own work, and a batch turning up small things around the files it opens.
Both make the script fail until they are spoken for, which is the point.

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
