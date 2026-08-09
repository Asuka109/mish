# macOS updater contract

## Stage 1 foundation

Mish owns update selection and verification instead of exposing Tauri's updater
plugin directly to the Web layer. Stage 1 is deliberately `contract-only`: it
defines authenticated inputs and returns a `VerifiedUpdate`, but it has no
endpoint configuration, network client, download command, installation
operation, application replacement, relaunch, or System Proxy handoff.

The desktop release-profile probe reports this boundary as `updater:
contract-only`. It must not be interpreted as a working update path.

## Stage 2A transport and staging boundary

Stage 2A implements the credential-free runtime below the installation
boundary. One process-global Rust `UpdaterService` owns discovery, download,
cancellation, resume, verification, persistence, and ready-candidate state.
Desktop WebView and Browser Client callers reach the same instance through
desktop bridge protocol 29, and the desktop host retains that same instance for
future native projections. A reconnect, remount, duplicate operation key,
Profile change, or capture operation does not create a second updater or
replay a consequential command.

The shipped app still constructs this service as unconfigured because no
production public key or endpoint has been approved. Its honest shared
snapshot is `idle` with `configured: false`, and check/download commands return
the typed `not-configured` reason. The signed-direct release probe therefore
continues to report `updater: contract-only`. Configuring the service later is
a release-signing/publication change; it is not an installation action.

When a future protected build supplies configuration, Stable discovery starts
with GitHub's canonical latest published Release API object and
`/releases/latest/download/` paths. The API object must be non-draft,
non-prerelease, published, and `immutable: true`. The metadata and
metadata-signature paths must resolve to that same strict stable `v<version>`
Release or directly to GitHub's allowlisted Release asset CDN. A direct CDN
redirect is publication-visibility evidence only: after verifying the signed
Mish metadata, all reads are still derived from the API object's exact strict
stable `v<version>` Release. The payload and payload-signature latest paths must
also be visible before any payload download is admitted.

Alpha performs exactly one anonymous, bounded first-page Releases API read. It
ignores list order, rejects duplicate versions, considers only non-draft,
published immutable prereleases with strict
`major.minor.patch-alpha.sequence` tags, and selects the greatest SemVer. API
asset URLs, ordering, timestamps, uploaded state, immutable flag, and cache
state are discovery gates and hints only. After selection, every metadata,
signature, and payload identity is derived from the exact `v<version>` Release
path and authorized by the existing signed Mish contract.

## Selected Tauri contract

The repository selects the Tauri v2 static JSON contract documented in the
[official updater guide](https://v2.tauri.app/plugin/updater/). The future
signed-direct build overlay is
`apps/desktop/src-tauri/tauri.updater.contract.conf.json`, which fixes
`bundle.createUpdaterArtifacts` to `true`. Tauri v2 then produces
`Mish.app.tar.gz` and `Mish.app.tar.gz.sig` under the macOS bundle directory.
The release tool renames the payload for immutable release identity.

One release contributes exactly these updater assets:

| Asset                                   | Contract                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `Mish-<version>-aarch64.app.tar.gz`     | Exact Tauri macOS updater payload                     |
| `Mish-<version>-aarch64.app.tar.gz.sig` | Tauri Minisign payload signature                      |
| `mish-<channel>.json`                   | Signed Tauri v2 static JSON for one channel           |
| `mish-<channel>.json.sig`               | Detached Minisign signature over the exact JSON bytes |

The JSON has one platform entry, `darwin-aarch64`. Its required Tauri fields are
`version`, `platforms.darwin-aarch64.url`, and
`platforms.darwin-aarch64.signature`. The `mish` extension binds:

- schema version `1`;
- explicit `alpha` or `stable` channel;
- full lowercase source commit SHA;
- exact payload file name;
- exact payload byte count; and
- exact payload SHA-256.

The URL is exactly
`https://github.com/Asuka109/mish/releases/download/v<version>/<payload>`.
Credentials, user information, query parameters, fragments, redirects, custom
hosts, and alternate payload names are rejected.

The Stage 1 overlay is not passed to a production build. No production updater
public key or channel endpoint exists yet. No GitHub workflow can currently
read an updater signing key, create updater attestations, or publish updater
assets. A later live-release change must first satisfy the frozen
workflow/tooling, protected Environment, OIDC, runner, immutable artifact,
provenance, SBOM, digest, and separate publication controls in
[`trusted-release-boundary.md`](../operations/trusted-release-boundary.md).
Only then may it configure the protected updater signing key, ship the matching
public key, enable this overlay, and add the four verified assets to the
signed-direct candidate without weakening its DMG, SBOM, provenance,
notarization, Gatekeeper, checksum, or Draft-only gates.

## Channel and version policy

Versions use strict SemVer and never lexical ordering. Mish accepts canonical
`major.minor.patch` stable versions and
`major.minor.patch-alpha.sequence` Alpha versions. It rejects a leading `v`,
build metadata, other prerelease identifiers, missing components, and numeric
components with leading zeroes.

The selected channel must equal the signed metadata channel:

- `stable` accepts only a stable version, so a higher Alpha can never be
  selected by a stable policy;
- `alpha` accepts only an `alpha` prerelease;
- a channel switch is explicit when installed and selected channels differ;
- a switch still requires a strictly newer SemVer; and
- equal versions and every downgrade are rejected with typed reasons.

Skipped versions are allowed when they are strictly newer. The adapter reports
that fact as evidence; it does not require sequential releases.

## Verification order and replay defense

The application adapter uses the same Base64-wrapped Minisign format as the
Tauri updater. It performs the following ordered checks before producing a
candidate:

1. require and verify the detached metadata signature over the raw JSON bytes;
2. parse the strict JSON schema and validate channel and SemVer policy;
3. bind source SHA, platform, URL, payload name, size, and SHA-256;
4. require the published payload signature sidecar to equal the signature
   embedded in the authenticated Tauri JSON; and
5. compare the authenticated candidate identity with the current candidate and
   channel high-water before committing discovery; and
6. verify the payload signature over the exact payload bytes before publishing
   the private ready candidate.

Parsing unsigned metadata is not an authorization boundary. Missing, invalid,
mismatched, replayed, wrong-channel, wrong-version, renamed, truncated, or
substituted inputs return a typed error and no `VerifiedUpdate`.

Stage 1 models replay state as the set of previously accepted metadata digests.
Stage 2A stores a bounded set of accepted digests in the private candidate
store and rechecks it after signature verification on every discovery. The
same channel/version/metadata and payload identity is an idempotent no-change
result that restores the pre-check outer snapshot. The same version with a
different authenticated identity is a hard `version-digest-conflict`; an older
version remains a downgrade. Evicting an old digest never
weakens rollback defense because the store also retains a monotonic,
channel-specific accepted-version high-water mark. The adapter now exposes the
same ordered contract as authenticated metadata admission followed by
streaming verification of the complete staged payload. The compatibility
`verify_candidate` entry point still performs both steps in order.

## Authoritative operation state

The Rust snapshot contains a process authority ID, monotonic revision,
configured flag, typed `idle/checking/available/downloading/verifying/ready/
failed/cancelled` phase, operation ID, selected channel, candidate identity,
bounded byte progress, resumability, and one redacted terminal reason.
Candidate identity includes version, channel, source SHA, metadata digest,
payload name/digest/size, and payload-signature digest. The private persisted
binding and resume identity additionally include the digest of the normalized
authenticated immutable GitHub Release record. Neither surface includes an
endpoint, credential, signature body, or private path.

Check, download, and cancel commands require a bounded operation key. A
duplicate key is idempotent; a different key cannot overtake an in-flight
operation. Download does not begin during discovery, and `ready` never provides
an install command. Subscription registration captures its receiver before the
baseline, so later revisions cannot arrive before that baseline barrier.

### Check typed reducer proof

Updater Check is owned by a repository-specific, data-bearing
`CheckState`/`CheckInput`/`CheckEffect` model. The synchronous reducer contains
no I/O, clock, logging, task spawn, or platform call. It distinguishes Stable,
Checking, CommittingAvailable, NoUpdate, Failed, Cancelled, and Retired states,
then exhaustively projects them to the existing public updater DTO. In
particular, the internal NoUpdate and CommittingAvailable refinements do not
add a public phase or change existing RPC behavior.

A bounded Tokio inbox serializes Check admission. The owning runtime spawns
only reducer-emitted effects, retains every task handle, and turns panic,
abort, completion conflict, cancellation, and shutdown into reducer inputs.
Reducer admission and public projection share one synchronous outer-state
cutover with download admission, but no aggregate lock crosses an await. Every
effect completion carries the machine authority, scope epoch, operation ID,
admitted revision, and effect ID; a mismatch is retired, finalized exactly once,
and cannot mutate state. The updater's domain observer records the resulting
redacted transition evidence.

Cancellation remains a request while discovery owns the outcome.
Checking → CommittingAvailable is the commit point: cancellation before it
wins when the discovery effect or its finalizer returns, while cancellation
after it is explicitly too late and cannot erase a candidate being committed.
Shutdown requests cancellation, waits for owned tasks for a bounded grace
period, aborts an uncooperative task, joins it, and retires the aggregate with a
deterministic terminal projection.

Updater-owned transition evidence is retained in a bounded in-memory ring. It
contains only sequence, state/input labels, disposition, scope epoch, admitted
revision, effect ID, and SHA-256 digests of the machine authority and operation
ID.
Endpoint URLs, credentials, raw metadata or payload bodies, signature material,
private paths, Profile data, and platform observations are never included.

The accepted Check vocabulary now runs through the repository-owned
`mish-state-machine` kernel. `CheckState`, `CheckInput`, `CheckEffect`,
projection, and updater errors remain owned by `mish-updater`; only bounded
admission, correlation, owned effect tasks, finalizers, shutdown, and transition
observer dispatch moved to the shared execution layer. The updater retains its
own bounded redacted evidence contract. This migration does not change
the public updater DTO/RPC behavior or the discovery-to-commit cancellation
cutoff. See
[`state-machine-kernel.md`](state-machine-kernel.md).

#### Go/no-go review for follow-up aggregates

| Review dimension          | Prior Check orchestration                                                        | Typed reducer proof                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Legal state               | DTO fields were mutated across orchestration branches                            | Data-bearing variants make illegal field combinations unrepresentable and one exhaustive Adapter owns DTO projection                |
| Admission and ordering    | Mutex checks and a spawned operation task shared lifecycle responsibility        | One bounded inbox admits commands; complete authority/scope/operation/revision/effect correlation rejects retired work              |
| Cancellation commit point | Cancellation was token-driven without an explicit persistence cutoff             | CommittingAvailable names the cutoff; barrier tests prove cancel-before and cancel-after behavior                                   |
| Task failure and shutdown | Task ownership did not structurally require every exit to finalize the aggregate | Owned handles and finalizer inputs cover success, failure, panic, abort, completion conflict, and bounded shutdown                  |
| Verification surface      | Outcomes depended mainly on end-to-end service tests                             | Pure transition tables, bounded model exploration, paused-time tests, and barrier/failure fakes test the decision boundary directly |
| Interface cost            | Check behavior was interleaved with service I/O                                  | Domain types and reducer remain private; no framework, generic StateMachine abstraction, protocol phase, or Web authority was added |

The proof is **GO** on invariant clarity, failure handling, and interface
readability: stale work is rejected by one complete correlation rule,
cancellation has one named commit point, and every owned task exit has a
deterministic reducer path. Dependent architecture work was authorized only
after completed Issue #285 was accepted, its required gates passed, and its
change merged. That acceptance did not authorize Capture/TUN, download/install, UI,
publication, or a generic state-machine framework.

### Download, Verify, and Ready typed reducer

Updater Continuation extends the same repository-owned kernel through
Downloading, Verifying, CommittingCandidate, Ready, Interrupted, Finalizing,
Failed, Cancelled, RecoveryRequired, Recovering, and Retired data-bearing
states. The reducer owns no network, filesystem, clock, logging, or task-spawn
work. Its effects carry machine authority, scope epoch, operation ID, admitted
revision, effect ID, and a monotonic progress sequence. A completion that
differs on any dimension, repeats a progress sequence, or supplies a different
outcome for an equal revision is retired without changing current state.

A partial-progress input is admitted only after the private payload file has
been flushed and fsynced. `CommittingCandidate` is the later immutable
publication cutoff: cancellation before it wins after the current Download or
Verify effect finalizes, while cancellation after it is explicitly too late.
Failure cleanup remains in `Finalizing`, so duplicate commands stay blocked
until partial retention or removal has been observed. A panic, abort,
completion conflict, shutdown, or commit result that cannot prove the
filesystem outcome ends in a typed failed, retired, or recovery-required state.

`recovery.json` is a versioned, bounded, mode-`0600` RecoveryRecord. It contains
only the public candidate identity, hashed machine authority, bounded operation
ownership, commit stage, progress sequence, committed byte count, and an
optional strong-ETag digest. Authenticated metadata and signatures remain in
the separately validated private binding and manifest. The RecoveryRecord has
no metadata body, signature body, URL, credential, or private path.
`candidate-commit-started` is evidence of an unknown outcome, not permission to
replay publication. Restart observes the managed store and re-verifies the
immutable payload's ownership, mode, links, size, SHA-256, and Minisign before
the new process publishes Ready. A partial remains Interrupted until an
explicit Download command resumes it.

## Bounded HTTP and resume

One Rustls-backed HTTP client is reused per configured updater. Stable latest
discovery stops and validates GitHub's one-hop redirect to either the exact
immutable Release path or a known GitHub Release asset CDN path. The CDN
location is never fetched as an authorization source; a cross-version,
untrusted-CDN, missing, or malformed location is rejected.
For a subsequent immutable asset read, at most one redirect is followed, only
from an exact credential-free `github.com` `v<version>` Release asset URL to a
known HTTPS GitHub release-asset CDN path; every other redirect is stopped and
rejected. Response encoding must be identity, and connect,
whole-operation, and idle-body time are bounded. Metadata and signature bodies
have independent caps. Signed payload size must be non-zero and below the
configured disk/body cap before download admission; streamed bytes may never
exceed the signed size.

An interrupted partial is resumable only when its private manifest still binds
the same channel, version, source SHA, payload digest/size, payload-signature
digest, metadata digest, operation, and strong ETag. Resume sends `Range` plus
`If-Range` and accepts only an exact `206 Content-Range` for the retained
offset and signed total. A safe `200` response means the server ignored Range:
Mish truncates the managed partial and restarts from byte zero. Mismatched
range semantics, weak/missing validators, truncation, trailing bytes, changed
identity, or overgrowth discard the partial or fail closed; no partial byte is
ever called verified.

Test-only URL rewriting maps canonical API, latest, and immutable Release paths
to a loopback fixture server. Production configuration has no such adapter and
accepts only the exact application-owned Stable latest base or bounded
anonymous Alpha Releases API endpoint. No production endpoint overlay is
present in the shipped application.

## Private candidate store and restart

The store root is absolute, canonical, current-user-owned, and private. Managed
directories and mutable files are `0700`/`0600`; the published candidate
directory and files become `0500`/`0400`. Fixed managed names, no-follow
metadata checks, one-link files, owner/mode checks, bounded directory scans,
permission-aware removal of immutable managed directories, same-filesystem
temporary names, fsync, and atomic rename prevent symlink, hard-link,
path-escape, partial-publication, and duplicate-candidate confusion. Cleanup is
confined to this dedicated root and never follows a link or removes the link
target.

The partial manifest retains authenticated metadata and resume identity. On
process restart, Mish re-verifies that metadata before exposing `available` or
a typed `failed: interrupted` resumable state. Interrupted work is never
automatically replayed. A committed or commit-unknown candidate enters the
internal RecoveryRequired/Recovering path and is reconstructed only after a
fresh effect rechecks private ownership/mode/link count, exact size, SHA-256,
and Minisign over the immutable payload. Foreign, corrupt, stale, overlong, or
unrecognized managed state is removed within a bounded scan. Unrelated files
outside the store remain untouched.

## Stage 2B local installation adapter proof

Stage 2B proves only the Rust installation boundary; it does not enable an
installation capability. Discovery normalizes the security-relevant fields of
the selected GitHub API Release object: Release ID, exact tag and version,
channel, publication timestamp, and the complete sorted set of uploaded asset
IDs and names. That record is persisted in the candidate manifest and its
SHA-256 is part of the candidate and resume identity. Field, asset, tag,
version, channel, or publication drift therefore changes the bound identity.

After a process restart, a verified ready candidate remains visible as ready,
but its installation context is unavailable. The Rust adapter may perform one
bounded anonymous `GET /repos/Asuka109/mish/releases/tags/v<exact-version>`
request. It accepts only the same fully validated normalized Release record.
Network unavailability leaves ready state intact and returns
`installation-context-unavailable`; any record or asset drift returns
`release-drift`. This rebind never requests metadata sidecars or the payload.

Immediately before handoff, the adapter reopens the immutable candidate
directory with `O_NOFOLLOW`, opens the manifest and payload relative to that
directory with `openat(..., O_NOFOLLOW)`, and confirms the opened directory is
still the exact path identity. It then rechecks exact current-user ownership,
`0500`/`0400` modes, single-link files, bounded manifest, exact payload size,
the complete persisted metadata and Release binding, SHA-256, and Minisign.
The payload file is read into one size-bounded byte buffer once. A consuming
Rust seam receives that exact buffer once; redacted evidence records one file
read, one handoff, and zero network payload downloads.

The selected public seam is Tauri updater v2
[`Update::install(bytes)`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs),
which accepts caller-provided bytes synchronously. Only Tauri's separate
`download` and `download_and_install` methods fetch a payload. A dev-only,
exactly pinned `tauri-plugin-updater` dependency compile-checks the direct
`update.install(bytes)` call. The normal `mish-updater` dependency graph,
desktop host, Web package, capability manifest, RPC protocol, and application
bundle contain no updater plugin or install command.

The adapter's only shipped constructor is capability-disabled. Tests alone
can construct the proof capability, and no test invokes Tauri's real installer.
Duplicate, cancelled, replaced-operation, stale-revision, malformed,
oversized, disabled-capability, store-tamper, Release-drift, offline, seam
rejection, and task-finalization outcomes are stable redacted codes. None
changes ready state, replaces the application, invokes an installer, exits,
relaunches, or adds a WebView/Browser Client authority path.

## Maintenance journal and restart reconciliation

The third updater aggregate extends the existing Check and Continuation
authorities without replacing their candidate store. It models the future
installation boundary while the shipped service remains `configured: false`
and exposes no install or restart command.

| State                   | Legal next state                              | Cancellation and cleanup                                      |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `ready`                 | `preparing-maintenance`                       | A duplicate operation is unchanged; another operation is busy |
| `preparing-maintenance` | `installing-intent`, `cancelled`, or `failed` | Cancellation wins and clears only its own durable record      |
| `installing-intent`     | `relaunching` or `recovering`                 | Cancellation is too late; restart never replays install       |
| `relaunching`           | `recovering`                                  | Process loss becomes an unknown outcome                       |
| `recovering`            | `completed` or `failed`                       | Evidence remains until the same operation resolves recovery   |
| terminal                | no consequential transition                   | Terminal record is fsynced, then operation-owned cleanup runs |

Every consequential input carries the bounded operation key, admitted
revision, current journal revision, and a digest of the process authority. A
new maintenance operation is admitted only when its claimed current version
exactly matches the version observed by that Rust authority and its admitted
revision strictly advances the authority's last retained revision. Admission
also reserves four revision advances for installing intent, relaunch, recovery,
and its terminal outcome, so no accepted lifecycle can overflow after journal
commit. A replacement runtime durably adopts recovery ownership for the same
operation and journal revision; repeated recovery-process restarts therefore do
not consume terminal revision headroom, while the replaced authority hash can
no longer advance or clean the record. A
duplicate exact input is idempotent. A stale revision, replacement authority,
other operation key, reconnect baseline, or retired finalizer cannot advance
or clear the retained record. Shutdown before `installing-intent` linearizes as
cancelled; shutdown after it linearizes as `recovering`. Check and Continuation
retain their existing owned-task finalizers. The pure repository-kernel
`MaintenanceMachine` reducer owns the closed transition table; its synchronous
journal authority executes each accepted commit and has no detached task or
platform effect to replay.

Terminal commit and cleanup are separate durable boundaries. If unlink or the
following directory fsync fails, the in-memory authority retains the exact
terminal operation/revision with automatic activation blocked; the identical
command retries only operation-owned cleanup and never recommits the outcome.

`updater-maintenance/journal.json` is schema version 1 and is capped at 4 KiB.
Validation binds each phase to its exact reachable revision offset from
admission. A syntactically valid revision jump is corrupt evidence, remains on
disk, and blocks automatic activation instead of overflowing startup or
creating an unresolvable recovery.
It contains only canonical previous/expected application versions, the bounded
operation key and revisions, digested process authority, `none` or
`restore-prior-capture` intent, and optional digested capture authority plus
revision. It contains no endpoint or credential, signature, candidate or raw
metadata/body, Profile/configuration data, capture configuration, or path.
Directories/files are current-user-owned `0700`/`0600` entries with no links.
Opening the authority validates the journal root and fsyncs its parent, including
immediately after first creation, before any journal commit can be admitted.
Each commit writes a create-new same-directory temporary file, fsyncs it,
atomically replaces the journal, revalidates its private ownership/mode/link
count, and fsyncs the directory. Cleanup rereads and matches operation ownership
and revision before unlink plus directory fsync. Corrupt, incompatible, linked, foreign, or
otherwise unsafe evidence is retained and fails closed instead of being
guessed or deleted.

If rename succeeds but the directory fsync reports failure, the command remains
ambiguous rather than accepted. Its exact duplicate must reread the complete
record, reconfirm directory durability, and restore the in-memory authority
before it may report success or advance to another maintenance boundary.

Desktop constructs this authority immediately after resolving the app-data
root, before Profile selection recovery, Core recovery, Capture audit,
schedulers, bridge publication, or automatic launch policy. Startup outcomes
are deterministic:

- no record or an operation-owned pre-install abort permits ordinary startup;
- `installing-intent`, `relaunching`, or `recovering` records never replay
  installation and block automatic activation;
- the observed application version is classified as expected, old, or
  unexpected while the record moves to `recovering`;
- corrupt or incompatible evidence remains retained and blocks automatic
  activation; and
- a valid terminal record is cleared only after its own terminal commit is
  observed.

The shared snapshot/event projection exposes only phase, revision, bounded
operation presence, capture intent, semantic reconciliation outcome, and
previously authenticated version facts. Support bundles use a smaller
candidate-free projection and never include journal ownership hashes or local
paths. Browser Client remains an observer with the existing non-privileged
check/download/cancel methods; no maintenance, install, relaunch, System Proxy,
TUN, or Capture mutation method exists in protocol 37.

## Provenance and diagnostics

`VerifiedUpdate` contains only the signed channel, version, source SHA, payload
identity, metadata digest, and selection facts. The adapter's diagnostic
surface exposes stable error codes only. It does not echo endpoint URLs,
signatures, raw metadata, source content, credentials, local paths, or unrelated
network data.

Repository fixtures use one fixed fixture-only public key plus Alpha and Stable
plain-text payloads, JSON, and signatures. The private key is not stored and
the public key is not trusted by a shipped build. The credential-free lifecycle
fixture models Draft creation, exact asset upload and digest read-back,
interruption while still hidden, immutable publication, Stable latest
visibility as the final step, Alpha list visibility, and replay/high-water
classification. It performs no Apple, GitHub, or third-party network action and
makes no live-publication claim.

## Deterministic verification

`cargo test -p mish-updater` uses only the repository signing fixtures and a
loopback fixture server. It covers success, exact Range resume, no-Range
restart, cancellation, timeout, redirect rejection, metadata/body caps,
truncated/corrupt payloads, signature and identity failure, Draft/partial and
delayed-asset visibility, Stable latest cross-version redirects, anonymous
Alpha ordering and strict SemVer selection, idempotent rediscovery,
same-version digest conflict, concurrent operation keys, monotonic replay
high-water behavior, restart recovery,
immutable ready recovery and removal, symlink/hard-link rejection, and bounded
cleanup. Local-install tests additionally cover the pure handoff reducer,
bounded out-of-order model exploration, the real public Tauri method signature,
exact one-read/one-handoff/zero-payload-network instrumentation, exact-version
restart rebind, offline retention, Release drift, cancellation, duplicates,
replacement/stale correlation, malformed/oversized inputs, no-follow
mode/link/store tampering, disabled capability, seam rejection, and panic
finalization. Check-specific tests additionally cover its legal transition table,
bounded model sequences and DTO invariants, duplicate and competing admission,
all five correlation mismatches, equal-revision conflict, timeout, cancellation
on both sides of the commit point, commit failure, panic, aborted and
uncooperative tasks, bounded shutdown, and bounded redacted evidence. Desktop
bridge tests prove that simultaneous and reconnecting clients observe one
updater authority and revision. Web tests prove that the RPC client accepts
only newer nested revisions and never replays check/download/cancel during
reconnect.

Continuation-specific tests cover its legal transition table and DTO
invariants, bounded model exploration, every correlation dimension plus
progress ordering, equal-revision outcome conflict, durable partial progress,
barrier cancellation, Download/Verify/Finalize/Commit/Recovery failure
injection, panic and abort finalization, paused-time uncooperative shutdown,
strong-ETag resume, crash/restart, commit-unknown observation without replay,
RecoveryRecord redaction, and mandatory candidate re-verification before
Ready.

Maintenance-specific tests cover every legal state, duplicate and competing
operation keys, cancellation on both sides of `installing-intent`, stale
revision and replacement authority retirement, pre-install and unknown-outcome
process loss, expected/old/unexpected version observation, terminal cleanup,
partial/corrupt/incompatible journal fixtures, private mode and link checks,
bounded redacted evidence, reconnect ordering, and the Desktop automatic-start
barrier. These fixtures do not invoke an installer, relaunch the application,
or mutate Capture.

## Later live and installation boundaries

The following remain unavailable and require separate review and hands-on
acceptance:

- updater signing-key custody and rotation;
- production public-key and channel endpoint enablement;
- pre-replacement System Proxy reconciliation and recovery authority;
- enabling the proven Rust seam for real application replacement, rollback,
  and prior-app preservation;
- live relaunch execution and post-relaunch Capture restoration; and
- two-version signed Alpha/stable upgrade and failure testing.

The existing signed-direct DMG remains the direct-distribution artifact. This
contract does not change Apple Developer ID, notarization, stapling,
Gatekeeper, tag, Draft Release, or publication status.
