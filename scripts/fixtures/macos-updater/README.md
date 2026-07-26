# macOS updater fixture

These files are deterministic, credential-free Tauri v2 updater fixtures for
repository tests only. The public key and detached signatures were produced by
the pinned Tauri CLI. No private key is stored in the repository, and this key
must never be configured in a shipped Mish build.

The payload is intentionally plain fixture content despite its contract name.
It is not an application archive and cannot be installed.
