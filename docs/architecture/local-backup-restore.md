# Local backup and restore contracts

## Authority and scope

Local backup does not introduce a new durable model. The authoritative profile
record remains `FileProfileRepository`: profile metadata owns the refresh policy,
immutable source revisions own source bytes, normalized artifacts own runtime
input, and versioned patch sets own structured user edits. The authoritative
application preference record remains `settings.json` version 3 through
`FileSettingsRepository`. There is no separate scheduler, patch, or backup
database.

The JSON backup manifest is a transfer envelope only. Format version 1 records
the profile, normalized-artifact, patch, and settings schema versions that were
used to produce it. Unknown envelope fields, unsupported schema versions,
duplicate profile IDs, malformed identities, invalid base64, and content whose
SHA-256 revision or fingerprint disagrees with its declared identity are
rejected before restore preview. Nested settings fields are strict; nested
profile metadata and patch objects are validated by their versioned domain
schemas and the ordinary profile repository before commit.

The complete manifest is limited to 8 MiB and 128 profile entries. Profile
contents are base64-encoded inside the bounded JSON document; the WebView never
receives those bytes. Preview reports the exact prepared byte count and category
counts for the document that the native save panel will write.

## Export privacy boundary

The safe default scope includes application settings, structured profile
patches, and fixed refresh policies. It excludes both sensitive classes:

1. raw and normalized profile configuration, which can contain credentials and
   proxy secrets; and
2. subscription URLs and full local source paths.

Profile contents are one explicit sensitive selection. Source locators are a
second explicit selection that is available only when profile contents are also
selected. These choices and their consequences appear before preview. Runtime
process state, active-profile state, refresh backoff counters, temporary refresh
timestamps, diagnostic history, event history, controller secrets, bridge
authentication tokens, System Proxy state, TUN state, capture journals, and OS
startup registration are never members of the format.

When profile content is selected without source locators, restore constructs a
private local source descriptor that points at the restored immutable revision
inside Mish application data. The profile remains inspectable and activatable,
but its refresh policy is forced off because no truthful remote or external local
source exists. A non-off schedule can be restored only with a validated HTTPS
source locator. Local-file sources always restore with scheduling off.

## Native file boundary

Four Tauri commands form the complete file boundary:

- export preview accepts only the closed scope DTO and retains exact prepared
  bytes under an opaque preview ID;
- export save accepts only that preview ID, opens the native save panel, and
  writes the retained bytes through a same-directory mode-0600 temporary file,
  data flush, atomic rename, and parent-directory flush;
- restore preview accepts no path, opens the native file picker, rejects
  symlinks and non-regular or oversized files, reads the selected file through a
  hard byte bound, validates it, and retains the parsed manifest under an opaque
  preview ID; and
- restore commit accepts only that preview ID and one closed conflict policy.

No loopback RPC method accepts a backup path, destination path, file contents,
or arbitrary filesystem operation. Ordinary browsers construct an explicit
unavailable client and never invoke Tauri.

## Restore planning and conflicts

Preview compares every backup entry with current repository identity. It reports
adds, exact-identity replacements, patch or schedule updates, skips, and typed
conflicts:

- the same ID points to a different revision or fingerprint;
- another ID already owns the same revision and fingerprint;
- a patch- or schedule-only entry has no current profile;
- a patch- or schedule-only entry is bound to a stale revision or fingerprint;
  or
- the current profile is active.

The user chooses either to keep current data or use backup data where replacement
is safe. Backup content can replace a divergent inactive ID and can deduplicate
an inactive identical fingerprint. Patch- and schedule-only entries are never
rebound across revisions. Active profiles are never replaced by restore. A
digest covering current profile records and settings expires the preview if
state changes before commit.

## Transaction and side-effect rules

Restore first builds a complete staged profile repository and staged settings
file using the ordinary domain repositories. This validates every reconstructed
`ProfileRecord`, including schema versions, revision hashes, artifact
fingerprints, patch authority, structured patch application, and source rules.
Only after staging succeeds does one transaction rename current selected
components into a rollback directory and staged components into their
authoritative names. Any rename or directory-flush failure reverses completed
renames before returning an error. No per-profile partial commit is retained.

The transaction updates the in-memory settings snapshot only after filesystem
commit. That update deliberately bypasses platform adapters. Restore therefore
does not register login startup, apply OS preferences, start or restart Core,
activate a profile, enable System Proxy, enable TUN, install a helper, or modify
capture state. Publishing a profile snapshot after commit only informs the UI of
repository changes; it does not activate or reload runtime configuration.

## Verification

Rust tests cover safe default exclusions, strict version and unknown-field
rejection, bounded serialization, settings restore without platform adapters,
profile reconstruction, conflict planning, state-digest expiry, and rollback
behavior. Web tests cover the strict DTO schemas, the complete private invoke
client, browser unavailability, default-sensitive scope behavior, preview-before-
save interaction, and Settings integration. Workspace formatting, lint,
typechecking, Rust checks, Clippy, unit/integration tests, production build,
design lint, token checks, and documentation links remain release gates.
