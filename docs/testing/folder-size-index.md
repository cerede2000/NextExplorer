# Folder size index

The folder size index computes and displays the **recursive size of every
folder** in the explorer, the way filebrowser-quantum does — without ever
running a synchronous `du` in the request path. This page explains how the
feature works, how to configure it, and how to verify it end to end.

## How it works (in one minute)

Everything runs **in-process on the main thread** (no worker thread, no second
SQLite connection) to keep memory low. The heavy work stays off the request path
by being fully async, writing to SQLite in small batched transactions, and
yielding to the event loop between batches.

- **Storage** — a `folder_size_index` table (SQLite, WAL mode) holds a
  pre-computed recursive size per folder. Every HTTP read is an O(1) index
  lookup; a listing request never triggers a filesystem traversal.
- **Baseline** — the first time a volume is seen, a background walk (bounded
  concurrency, event-loop yields, iterative post-order so peak RAM is O(path
  depth), not O(whole tree)) records every folder's size once.
- **Incremental deltas** — NextExplorer's own writes (upload, delete, move,
  copy, folder create, rename) push a precise, ancestor-propagating delta into
  the index with no extra I/O. This is instant.
- **On-view refresh** — opening a folder asks the indexer, in the background, to
  re-check the mtime of the folders on screen and re-aggregate only the ones
  that changed. So external changes to folders you actually browse surface within
  seconds — without a filesystem watcher. The read response itself stays O(1).
- **Adaptive reconciliation** — a periodic mtime sweep of the whole index
  re-aggregates only changed folders. It accelerates (down to
  `FOLDER_SIZE_RECONCILE_MIN_MS`) when a pass finds external changes and backs
  off (doubling, up to `FOLDER_SIZE_RECONCILE_MAX_MS`) when idle. The sweep is
  **paced** — it stat()s folders in pages of `FOLDER_SIZE_RECONCILE_BATCH` and
  sleeps `FOLDER_SIZE_RECONCILE_PAUSE_MS` between pages, streaming rows a page at
  a time — so even a volume with hundreds of thousands of folders is scanned as a
  gentle background trickle (never one CPU/IO burst) using O(page) memory. This
  is the deep catch-all for changes to folders nobody browses.

There is deliberately **no filesystem watcher**: recursive inotify holds memory
proportional to the number of directories (hundreds of MB on large trees), which
dwarfs the rest of the feature. The three layers above keep sizes fresh at a
fraction of the RAM (the approach filebrowser-quantum also takes).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOLDER_SIZE_MODE` | `off` | `off` disables the feature. `full` = recursive folder sizes. `shallow` = size of a folder's *direct* entries only. |
| `FOLDER_SIZE_CONCURRENCY` | `6` | Baseline walk concurrency on local disks. |
| `FOLDER_SIZE_NETWORK_CONCURRENCY` | `2` | Concurrency when the mount is detected as network (nfs/cifs via `/proc/mounts`). |
| `FOLDER_SIZE_FLUSH_MS` | `3000` | How often accumulated dirty directories (on-view refresh, write hooks) are flushed in one transaction. |
| `FOLDER_SIZE_RECONCILE_MS` | `0` | `0` = adaptive reconciliation (see MIN/MAX). Set a non-zero value to force a fixed interval instead. |
| `FOLDER_SIZE_RECONCILE_MIN_MS` | `900000` | Fastest adaptive reconcile interval (used right after external changes are seen). |
| `FOLDER_SIZE_RECONCILE_MAX_MS` | `43200000` | Slowest adaptive reconcile interval (reached when the volume is idle). |
| `FOLDER_SIZE_RECONCILE_BATCH` | `100` | Folders stat()ed per page during a reconcile sweep. |
| `FOLDER_SIZE_RECONCILE_PAUSE_MS` | `200` | Sleep between reconcile pages — pacing that keeps the sweep gentle on huge volumes. |
| `FOLDER_SIZE_REBUILD` | `false` | Force a fresh baseline walk on startup. |

## Enabling it

Set `FOLDER_SIZE_MODE=full` in the backend environment (and
`SHOW_VOLUME_USAGE=true` if you also want the volume usage bar for comparison).
On the next start the indexer walks each volume once to build the baseline; from
then on updates are incremental. Nothing else is required — the
`folder_size_index` table is created automatically, and freshness comes from the
write hooks, on-view refresh and adaptive reconciliation.

## Verify in the UI

Browse into any volume. In the **list view** the *Size* column now shows a size
for folders (previously an em-dash), and sorting by *Size* orders folders by
their recursive size. If volume usage is enabled, the usage bar lets you compare
"space used on the disk" against "size of this folder".

## Verify via the API

The read endpoint returns the pre-computed size as an O(1) lookup. Authenticate
first (via your configured auth) to obtain a session cookie, then:

```bash
# Single folder
curl -s -b cookies.txt http://localhost:3000/api/folder-size/<volume>/<folder> | jq
# -> { "path": "<volume>/<folder>", "canEnter": true, "sizeBytes": 41560,
#      "entryCount": 2, "lastUpdated": "...", "indexed": true }

# Batch (populate a whole list view in one request)
curl -s -b cookies.txt -X POST http://localhost:3000/api/folder-size/batch \
  -H 'Content-Type: application/json' \
  -d '{"paths":["<volume>/A","<volume>/B","<volume>/B/C"]}' | jq
```

An un-indexed path returns `{"indexed": false, "sizeBytes": null}` with HTTP 200
— never a 500 and never a synchronous scan.

## Verify "size without access"

The size must be returned **even when the user is not allowed to enter the
folder** — indexing runs outside the user's access context. With a non-admin
user who has no access to a given volume:

```bash
curl -s -b viewer.txt http://localhost:3000/api/folder-size/<volume>/<folder> | jq
# -> { "canEnter": false, "sizeBytes": 41560, "indexed": true, ... }
```

`canEnter` is `false` but `sizeBytes` is still reported.

## Observe the indexer

The indexer logs under the `folderSizeIndexer` name; filter your backend logs
for it to watch the baseline walk complete and the flush / reconciliation passes
as files change. Setting `FOLDER_SIZE_REBUILD=true` clears a volume's entries and
re-walks from scratch on the next start — set it back to `false` afterwards so
ordinary restarts keep the existing index.

## Automated tests

The backend logic is covered by unit/integration tests (run from `backend/`):

```bash
npm test            # backend (vitest)
```

- `tests/services/folderSizeIndexer.test.js` — baseline aggregation, delta
  propagation, mtime reconciliation, vanished-folder pruning, and a
  non-blocking-scan guarantee.
- `tests/routes/folderSize.test.js` — size returned when access is denied,
  clean `indexed:false` for un-indexed paths (no synchronous fallback), and the
  batch endpoint.

Frontend store tests (run from `frontend/`):

```bash
npm run test:unit   # frontend (vitest)
```

- `src/stores/folderSize.spec.js` — throttle, in-flight de-duplication, and the
  feature-disabled no-op.
</content>
</invoke>
