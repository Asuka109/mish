# Local Backup Boundary

The current production graph does not expose an implicit backup or restore
authority. A future file operation must be a typed contract with an explicit
host seam, bounded transcript, privacy review, and deterministic replay. React
components may show a preview or confirmation state, but they must not read
arbitrary paths, write files, or create a second session/cache authority.

Fixture tests may use a private temporary directory and must clean it before
exit. They do not claim real user-file permission or external persistence.
