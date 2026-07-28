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
2. reject a metadata SHA-256 already recorded as accepted;
3. parse the strict JSON schema and validate channel and SemVer policy;
4. bind source SHA, platform, URL, payload name, size, and SHA-256;
5. require the published payload signature sidecar to equal the signature
   embedded in the authenticated Tauri JSON; and
6. verify that payload signature over the exact payload bytes.

Parsing unsigned metadata is not an authorization boundary. Missing, invalid,
mismatched, replayed, wrong-channel, wrong-version, renamed, truncated, or
substituted inputs return a typed error and no `VerifiedUpdate`.

Stage 1 models replay state as the set of previously accepted metadata digests.
Stage 2A stores a bounded set of accepted digests in the private candidate
store and rechecks it before every discovery. Evicting an old digest never
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
payload name/digest/size, and payload-signature digest. It never includes an
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
admitted revision, and effect ID; a mismatch is recorded as retired evidence
and cannot mutate state.

Cancellation remains a request while discovery owns the outcome.
Checking → CommittingAvailable is the commit point: cancellation before it
wins when the discovery effect or its finalizer returns, while cancellation
after it is explicitly too late and cannot erase a candidate being committed.
Shutdown requests cancellation, waits for owned tasks for a bounded grace
period, aborts an uncooperative task, joins it, and retires the aggregate with a
deterministic terminal projection.

Transition evidence is retained in a bounded in-memory ring. It contains only
sequence, state/input labels, disposition, scope epoch, admitted revision,
effect ID, and SHA-256 digests of the machine authority and operation ID.
Endpoint URLs, credentials, raw metadata or payload bodies, signature material,
private paths, Profile data, and platform observations are never included.

The accepted Check vocabulary now runs through the repository-owned
`mish-state-machine` kernel. `CheckState`, `CheckInput`, `CheckEffect`,
projection, and updater errors remain owned by `mish-updater`; only bounded
admission, correlation, owned effect tasks, finalizers, shutdown, and redacted
evidence moved to the shared execution layer. This migration does not change
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
deterministic reducer path. This conclusion authorizes dependent architecture
work only after Issue #285 is accepted, its required gates pass, and the change
is merged. It does not authorize Capture/TUN, download/install, UI,
publication, or a generic state-machine framework.

## Bounded HTTP and resume

One Rustls-backed HTTP client is reused per configured updater. At most one
redirect is followed, only from an exact credential-free `github.com` Release
asset URL to a known HTTPS GitHub release-asset CDN path; every other redirect
is stopped and rejected. Response encoding must be identity, and connect,
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

Test-only URL rewriting maps the already-authenticated release asset basename
to a loopback fixture server. Production configuration has no such adapter and
accepts only the selected channel's exact credential-free application-owned
GitHub Releases base:
`https://github.com/Asuka109/mish/releases/download/updater-<channel>/`.

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
a typed `failed: interrupted` resumable state. A ready candidate is reconstructed
only after rechecking private ownership/mode/link count, exact size, SHA-256,
and Minisign over the immutable payload. Foreign, corrupt, stale, overlong, or
unrecognized managed state is removed within a bounded scan. Unrelated files
outside the store remain untouched.

## Provenance and diagnostics

`VerifiedUpdate` contains only the signed channel, version, source SHA, payload
identity, metadata digest, and selection facts. The adapter's diagnostic
surface exposes stable error codes only. It does not echo endpoint URLs,
signatures, raw metadata, source content, credentials, local paths, or unrelated
network data.

Repository fixtures use a fixed public key, payload, JSON, and signatures. The
fixture payload is plain text, not an application archive. Its private key is
not stored, the key is not trusted by a shipped build, and fixture execution
performs no Apple, GitHub, or third-party network action.

## Deterministic verification

`cargo test -p mish-updater` uses only the repository signing fixtures and a
loopback fixture server. It covers success, exact Range resume, no-Range
restart, cancellation, timeout, redirect rejection, metadata/body caps,
truncated/corrupt payloads, signature and identity failure, replay, concurrent
operation keys, monotonic replay high-water behavior, restart recovery,
immutable ready recovery and removal, symlink/hard-link rejection, and bounded
cleanup. Check-specific tests additionally cover its legal transition table,
bounded model sequences and DTO invariants, duplicate and competing admission,
all five correlation mismatches, equal-revision conflict, timeout, cancellation
on both sides of the commit point, commit failure, panic, aborted and
uncooperative tasks, bounded shutdown, and bounded redacted evidence. Desktop
bridge tests prove that simultaneous and reconnecting clients observe one
updater authority and revision. Web tests prove that the RPC client accepts
only newer nested revisions and never replays check/download/cancel during
reconnect.

## Later live and installation boundaries

The following remain unavailable and require separate review and hands-on
acceptance:

- updater signing-key custody and rotation;
- production public-key and channel endpoint enablement;
- pre-replacement System Proxy reconciliation and recovery authority;
- application replacement, rollback, and prior-app preservation;
- relaunch and expected-version observation; and
- two-version signed Alpha/stable upgrade and failure testing.

The existing signed-direct DMG remains the direct-distribution artifact. This
contract does not change Apple Developer ID, notarization, stapling,
Gatekeeper, tag, Draft Release, or publication status.
