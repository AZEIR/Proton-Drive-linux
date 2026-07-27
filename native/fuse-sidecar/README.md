# FUSE 3 sidecar

This process is the crash-isolation boundary for the future production FUSE
backend. It uses libfuse3, a private `0600` control socket, bounded background
requests, kernel permission checking, and no privileged passthrough.

The current sidecar intentionally exposes only a health inode while the Node
core remains on the existing backend. Enablement is blocked until the versioned
metadata/cache IPC protocol and crash-injection suite are complete.
