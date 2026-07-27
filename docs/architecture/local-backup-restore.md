# Local backup and restore contracts

## Authority and scope

Local backup does not introduce a new durable model. The authoritative profile
record remains `FileProfileRepository`: profile metadata owns the refresh policy,
immutable source revisions own source bytes, normalized artifacts own runtime
input, and versioned patch sets own structured user edits. The authoritative
application preference record remains `settings.json` version 10 through
`FileSettingsRepository`. There is no separate scheduler, patch, or backup
database.

The internal development TUN client private key and any pending replacement are
outside every backup scope. They remain only in their user-owned mode-`0600`
runtime files and never enter a manifest, preview, exported bytes, restore
candidate, fixture, or source-locator field. Enrollment and rotation records
are also excluded; restoring ordinary application data cannot enroll, rotate,
reset, or recover helper trust.

The settings payload includes the closed System Proxy takeover policy. Its default is
`protect-existing`; restores preserve the selected bounded policy but never include live System
Proxy state, journals, credentials, PAC URLs, or network-service identities.

Settings backups preserve the versioned welcome-invitation record together with
the other preferences. Restoring that record transfers at most the same single
invitation and its opened, dismissed, or completed state; restore never creates
a second invitation. The independent prompted state is preserved as well, so a
restore does not repeat a message that the user has already seen.

All authoritative Profile and Settings writers share one
`StateMutationAuthority`. The desktop composition injects the same authority
into `ProfileService`, `SettingsService`, `ProfileActivationCoordinator`, and
`LocalBackupService`. A permit is identity-bound to that authority. Direct
service writers acquire their own permit; coordinator paths acquire once and
call permit-requiring methods to avoid nested locking.

The authority covers Profile save, manual and scheduled refresh, refresh-policy
changes, patch replacement, deletion, activation, safe stop, and every persisted
Settings change. Activation and refresh keep their permit across network and
process work rather than reserving only their final repository write. Restore
uses non-blocking acquisition and returns a typed `busy` conflict while one of
those operations is in progress. It does not cancel that operation. Duplicate
activation command IDs retain their existing idempotent result.

The desktop runtime host also acquires this authority for a System Proxy
recovery command. A backup commit and System Proxy Repair or Leave-as-is action
therefore cannot overlap. A busy recovery attempt does not consume the retained
backup preview, so the caller can retry the same confirmation after the current
recovery finishes. Starting a new native restore selection invalidates any
older retained preview before the file panel opens, including cancellation and
validation-failure paths.

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
rebound across revisions. Active profiles are never replaced by restore. Active
identity comes from the activation coordinator, not persisted Profile metadata.
Preview includes that identity in its digest. Commit acquires the shared mutation
permit, re-reads the coordinator identity under that same permit, and then
revalidates the complete Profile, Settings, and active-identity digest. An
activation transition therefore either owns the permit first or expires the
restore preview; it cannot occur between the active check and replacement.

Restore preview and confirmation expose the complete validated scope. They show
the selected Settings, patches, schedules, Profile contents, and source-locator
categories and independently mark both sensitive classes as included or
excluded: Profile credentials/configuration content, and subscription URLs/full
local paths. The default conflict policy remains `keep-existing`.

## Transaction, recovery, and atomicity terms

Restore first builds a complete staged profile repository and staged settings
file using the ordinary domain repositories. This validates every reconstructed
`ProfileRecord`, including schema versions, revision hashes, artifact
fingerprints, patch authority, structured patch application, and source rules.
Only after staging succeeds does the transaction create private mode-0700 stage
and rollback directories and persist a strict mode-0600 restore journal. The
journal has schema version 1, one UUID, a closed component enum (`profiles` or
`settings`), each component's original-existence bit, and one of three phases:
`committing`, `rolling-back`, or `committed`. It contains no user-controlled or
absolute path. Journal bytes and the parent-directory entry are fsynced before
the first authoritative component rename.

Each original-to-rollback and staged-to-authority rename is followed by fsync of
both affected parent directories. Ordinary rename or flush failure switches the
journal durably to `rolling-back` and reverses completed swaps. If rollback or
cleanup also fails, restore returns `recovery-required` and retains the journal,
stage, and rollback evidence. It never deletes the only recovery basis or
reports success. The live mutation authority then fails closed until restart,
preventing a later writer from obscuring the retained recovery state. A
successful data swap fsyncs the application-data directory,
then persists `committed`; only then may cleanup remove rollback data and finally
the journal.

Startup checks the journal before loading Settings, constructing Profile
services, starting the scheduler, exposing RPC/Tauri commands, or creating a
managed runtime. `committing` and `rolling-back` transactions are idempotently
rolled back to the prior generation. `committed` transactions retain the new
generation and finish cleanup. Any recovery failure aborts startup and preserves
diagnostic state for a later retry.

Startup accepts only a regular, bounded, mode-0600 restore journal owned by the
same account as the application-data root. Its transaction stage and rollback
roots must remain private mode-0700 directories with the same ownership. A
symlink, non-private file, stale version, malformed record, oversized record,
or ownership mismatch aborts recovery without renaming an authoritative
Profile or Settings component.

These terms are intentionally distinct:

- repository JSON/file writes are single-file atomic replacement when their
  same-directory temporary-file rename succeeds;
- an ordinary multi-component restore failure is rollback-capable while the
  process remains alive;
- the journal makes the multi-component restore crash-recoverable across process
  termination or power loss; and
- the Profile directory plus `settings.json` do **not** become one filesystem
  atomic rename. Observers are excluded by the shared mutation authority, while
  startup recovery resolves any intermediate generation before availability.

## Side-effect rules

Restore keeps its mutation permit from final digest validation through staging,
filesystem commit, the in-memory Settings snapshot update, and Profile
publication. The in-memory update happens only after filesystem commit and
deliberately bypasses platform adapters. Restore therefore
does not register login startup, apply OS preferences, start or restart Core,
activate a profile, enable System Proxy, enable TUN, install a helper, or modify
capture state. Publishing a profile snapshot after commit only informs the UI of
repository changes; it does not activate or reload runtime configuration.

## Verification

Rust tests cover safe default exclusions, strict version and unknown-field
rejection, bounded serialization, settings restore without platform adapters,
profile reconstruction, conflict planning, active-transition digest expiry,
active replacement protection, typed busy results for every Profile writer,
and authority retention during activation. An injectable restore filesystem
exercises every component-swap crash checkpoint, ordinary rollback, rollback
failure with retained evidence, committed cleanup, and idempotent startup
recovery. Web tests cover the strict DTO schemas, the complete private invoke
client, browser unavailability, default-sensitive scope behavior, preview-before-
save interaction, explicit restore-sensitive scope confirmation, and Settings
integration. Workspace formatting, lint,
typechecking, Rust checks, Clippy, unit/integration tests, production build,
design lint, token checks, and documentation links remain release gates.
