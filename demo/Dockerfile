# The published release, with something in it to look at.
#
# The demo runs without a persistent disk, deliberately: whatever a visitor
# uploads, renames or deletes lives until the service restarts, and then this
# image's /mnt comes back exactly as it is here. That is the reset, and it costs
# nothing to operate.
#
# Lean rather than full: hardware video acceleration and RAW decoding are no use
# on a small instance, and the smaller image starts faster after the free plan
# has put the service to sleep.
FROM ghcr.io/cerede2000/explorer:latest-lean

# Copied straight into the volume root rather than seeded by an entrypoint of
# our own. An earlier version did the latter and the demo came up with no
# volumes at all — a script that silently does not run looks exactly like a
# script that ran and found nothing. There is nothing here that can fail to
# happen: the content is in the image, at the path the application serves.
COPY content/ /mnt/

# The image's entrypoint chowns /config and /cache but deliberately leaves /mnt
# alone: in a real deployment that is the host's filesystem, and changing its
# ownership would be rude at best. Here it is ours, and the demo has to be
# writable — uploading, renaming and moving things is most of what it is for.
#
# By number, not by name. `adduser -S` gives appuser a system UID, and the
# entrypoint renumbers it to PUID (1000 by default) at boot — so `chown appuser`
# here writes an id that is stale by the time the application runs, and every
# write fails with EACCES on a demo that looks otherwise fine.
RUN chown -R 1000:1000 /mnt
