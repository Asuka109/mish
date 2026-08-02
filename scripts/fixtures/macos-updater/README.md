# macOS updater fixture

These Alpha and Stable files are deterministic, credential-free Tauri v2
updater fixtures for repository tests only. The committed public key and
detached Minisign-compatible signatures were produced from a one-time fixture
key. The private key was discarded, is not stored in the repository, and this
public key must never be configured in a shipped Mish build.

The payloads are intentionally plain fixture content despite their contract
names. They are not application archives and cannot be installed or published.
