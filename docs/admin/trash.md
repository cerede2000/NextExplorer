# Trash

Deleting a file or folder moves it to the trash instead of removing it. It stays there for a retention period (30 days by default), can be restored from the **Trash** page in the sidebar, and is then removed for good.

## How it works

- **No copy, ever.** Each volume keeps its trash in a hidden `.nextexplorer` folder at its root. Deleting is a rename on the same disk: a 40 GB folder goes to the trash as fast as a small file, and needs no free space to do so. Personal folders and volumes assigned to users outside `VOLUME_ROOT` have their own `.nextexplorer` folder the same way.
- **Nobody browses the zone.** The `.nextexplorer` folder never appears in listings or search, whatever the hidden-file settings say, and no path through it can be opened, downloaded or shared. Nothing can be named `.nextexplorer`.
- **Shares go at once.** A share pointing at a deleted item is removed when the item goes to the trash, as before: nothing in the trash stays public. Restoring does not bring shares back.
- **Crash-safe.** Every operation writes what it is about to do before it touches the disk. After a crash or a power cut, the next start finishes or undoes whatever was interrupted. Content found in a zone without a record — a database restored from an older backup — is adopted rather than deleted; each item carries a small description beside it for that purpose.

## Who sees what

- Each person sees what they deleted, and what came from their own personal folder or from shares they own.
- Administrators see everything.
- Share visitors have no trash: what they delete through a share link goes to the share owner's trash.
- Restoring puts an item back where it was. A parent folder that no longer exists is recreated; a name that is now taken gets a suffix, like a copy. Someone who has lost write access to the original location since the deletion cannot restore into it — an administrator can.

## When an item cannot go to the trash

The delete dialog says, before anyone confirms, which items would be removed for good and why:

- the item is on **another disk** than its volume's trash (a network share or a separate mount inside a volume);
- it is **larger than the whole trash** of its volume;
- it is **a volume itself**, which cannot go into its own trash.

A folder's size is only known once it is measured, during the deletion. If it turns out too large then, it is left where it is and the person is asked again. A deletion is never permanent without the person having been told.

The dialog also offers **Delete permanently** to skip the trash on purpose.

## Space and retention

The trash of each volume may hold at most a share of the volume (10% by default), optionally capped by a size. A maintenance pass runs at startup, every hour, and shortly after deletions:

1. items past their retention are removed for good, whatever the space;
2. while the trash is over its budget, or the volume is below the upload reserve (`UPLOAD_STORAGE_RESERVE`), the oldest items are removed first.

Before an upload is refused for lack of space, the trash of the destination volume gives back its oldest items — but only when that is enough for the upload to fit.

Every early removal (before the retention), recovery or failure is recorded in the zone's journal, shown in **Settings → Trash**.

## Settings → Trash

Administrators can:

- switch the trash on or off, and set the retention and the size limits (the defaults come from [environment variables](/configuration/environment#trash));
- see, for each volume, what its trash holds, its budget, and what the last maintenance did;
- **Verify** that every zone's records and files agree;
- **Run maintenance now**.

A zone whose disk is not mounted, or has been replaced by another one, is shown as unavailable and left untouched: an unmounted disk and an emptied trash look the same from a path, and nextExplorer never removes records on that basis. An administrator who knows the disk is gone for good can delete those items from the Trash page to forget them.

## Backups

The `.nextexplorer` folder is inside each volume, so a backup of the volume includes the trash. Exclude `.nextexplorer/` from backups if you do not want to back up deleted items.
