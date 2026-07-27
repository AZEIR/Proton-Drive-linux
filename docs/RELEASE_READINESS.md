# Reliability, security, performance, and UI readiness

This document records the implementation state of the audit-led hardening
work. It is a release gate, not a claim that the experimental FUSE backend is
production-ready.

## Implemented

- Node 22 production runtime; Bun is limited to build and development tasks.
- SDK submodule based on the current official `main`, with a small Linux
  compatibility patch for Node credentials/runtime behavior and quota display.
- Secret Service credentials by default. The headless plaintext store requires
  explicit opt-in and uses `0700` directories, `0600` files, atomic rename, and
  file/directory sync.
- Authenticated browser APIs with a short-lived HttpOnly session, same-origin
  enforcement, CSRF protection, strict CSP, and no inline script/style.
- A `0600` Unix control socket for tray mutations.
- A shared adaptive transfer governor with weighted priorities, bounded queues,
  bounded buffered-byte accounting, aggregate rate limits, full-jitter retry
  feedback, and `Retry-After` handling.
- A separate `journal.sqlite` in WAL/FULL mode for acknowledged FUSE
  operations and a durable remote-event inbox.
- Immutable upload snapshots, verified atomic full-sync downloads, verified
  revision-aware FUSE cache publication, and durable FUSE flush/close.
- Incomplete FUSE scans preserve existing mappings. Full scans do not mutate
  mappings until traversal has succeeded.
- Local-first FUSE mkdir, rename, and delete replay; stable inode identifiers;
  callback deadlines for network-dependent paths; and bounded scan workers.
- Versioned releases, automatic rollback, hardened systemd services, pinned CI
  actions, dependency auditing, CodeQL, SBOM generation, checksums, and build
  provenance.
- Dashboard network health, throughput, ETA, queue, durable-work, cache, and
  accessible interaction states.

## Production gates still open

The Rust FUSE 3 sidecar currently provides the isolation/control foundation and
a health inode only. The existing FUSE implementation remains the active
backend. Do not enable `drive-fuse.service` as the production filesystem until
all of the following are complete:

1. Implement and version the Node-to-Rust metadata/cache IPC protocol.
2. Move the supported POSIX callback surface into the Rust sidecar.
3. Replace whole-file hydration with SDK-supported verified range/block cache
   reads, read-ahead, pinning, and byte-based eviction.
4. Add fusectl connection monitoring, forced abort, and safe remount
   supervision.
5. Run the distro matrix, `pjdfstest`/stress subsets, crash/power-loss and
   network-fault injection, 100,000-entry tests, and the 72-hour soak.
6. Measure the direct-SDK, uncached-FUSE, cached-filesystem, memory, and rate
   limit acceptance thresholds on controlled hardware.
7. Complete browser automation for keyboard, screen-reader, reduced-motion,
   CSP, responsive, and large-tree behavior.

Until those gates pass, full sync is the production candidate and FUSE remains
experimental. Keep independent backups of important data.

## Local verification

```bash
bun run check-types
bun run test
bun run build
bun audit --json
(cd sdk/cli && bun run check-types)
(cd native/fuse-sidecar && cargo test --locked)
bash -n setup.sh drive.sh uninstall.sh
git diff --check
```
