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

**The plan is closed.** Every subject of nxzai#373 is on `main` upstream, and
so are the two that followed it: the volume guard this fork had and upstream
did not (nxzai#409), and the file routes, the shared editor and the editor's
storage picker that closed the last of the API surface.

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

Measured 26 September 2026, by reading the routers of both trees rather than by
diffing files: **upstream mounts every route this fork does, bar one.**

`GET /api/files/recent-destinations` serves the destination dialog, which is
below among the things this plan never claimed. It stays here with it.

What still differs is this fork's own shape rather than what the application
does: the file store split into modules, the rewritten folder view, the quick
actions, the clipboard progress panel, the destination dialog, the operations
store — and, beside them, prose rewritten and functions restructured after each
batch had already gone over. None of it is a capability upstream lacks.

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
