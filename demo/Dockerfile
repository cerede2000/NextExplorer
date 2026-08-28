# The published release, with something in it to look at.
#
# The demo runs without a persistent disk, deliberately: whatever a visitor
# uploads, renames or deletes lives until the service restarts, and then the
# folders below come back exactly as they are here. That is the reset, and it
# costs nothing to operate.
#
# Lean rather than full: hardware video acceleration and RAW decoding are no use
# on a small instance, and the smaller image starts faster after the free plan
# has put the service to sleep.
FROM ghcr.io/cerede2000/explorer:latest-lean

# Baked into the image rather than downloaded at boot, so a cold start is not
# waiting on a network fetch it might not be allowed to make.
COPY content/ /demo-content/

# The application takes its volumes from VOLUME_ROOT, which starts out empty on
# every boot. Seed it before handing over to the normal entrypoint.
COPY seed.sh /usr/local/bin/seed-demo.sh
RUN chmod +x /usr/local/bin/seed-demo.sh

ENTRYPOINT ["/usr/local/bin/seed-demo.sh"]
CMD ["node", "src/server.js"]
