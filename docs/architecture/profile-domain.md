# Profile domain, preflight, and persistence

## Decision

`crates/profile` owns the transport- and UI-independent Profile domain. It
defines source identity, provenance, immutable revisions, normalized artifacts,
stable fingerprints, validation results, lifecycle attempts, last success, and
versioned structured patches, plus the active/valid/stale/updating/warning/error
status vocabulary. It does not
render Profiles UI, call Tauri, start Mihomo, activate capture, or depend on the
Controller client.

An imported YAML document is never treated as both user policy and desktop
application state. The crate retains the received bytes as an immutable source
revision and creates a separate normalized runtime artifact. Normalization
preserves syntactically valid unknown YAML values semantically, but does not
promise byte-for-byte formatting, comments, anchors, or in-place editing. Every
successful preflight therefore reports this limitation and keeps the immutable
source.

The Profile service also derives a bounded, read-only route catalog from the
patched effective configuration. This catalog exposes policy-group type and
configuration order, direct member order, opaque labels, and proxy protocol,
but never returns source YAML or credentials. Routes uses it only when no live
Controller catalog is available, so a selected profile remains inspectable
while Mihomo is stopped. Runtime selection, provider expansion, health, and
latency remain Controller-owned observations.

## Domain vocabulary

| Term                  | Meaning                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `ProfileSource`       | A validated absolute local-file path or HTTPS URL. URL user-info and fragments are rejected.       |
| `Provenance`          | Safe source summary, import timestamp, and immutable source revision ID.                           |
| `ImmutableRevision`   | SHA-256-addressed received bytes plus size, media type, and creation time.                         |
| `NormalizedArtifact`  | Generated YAML, its schema version, source revision, size, and SHA-256 fingerprint.                |
| `ValidationResult`    | Typed valid/invalid outcome with safe warnings and errors.                                         |
| `ProfileAttempt`      | Timestamp and success/failure of the latest lifecycle attempt.                                     |
| `ProfileSuccess`      | Timestamp, revision, and fingerprint of the last known valid result.                               |
| `ProfileRefreshState` | Fixed automatic-refresh policy, next run, last refresh success/failure, and bounded failure count. |
| `ProfileStatus`       | Independent active, valid, stale, updating, warning, and error flags for later view mapping.       |

Profile IDs are canonical random UUIDs and remain stable across revisions.
Revision IDs hash the exact received source bytes. Artifact fingerprints hash
the deterministic normalized bytes and are the stable input for future
profile-scoped observations.

## Preflight boundary

`ImportPreflight` accepts injected `LocalSourceReader` and `HttpsSourceReader`
implementations. This keeps filesystem dialogs, HTTP stacks, proxy routing, and
platform trust policy outside the domain while making both source types
deterministically testable. The default policy is:

- 4 MiB maximum received body;
- 15-second end-to-end reader timeout;
- at most three HTTPS redirects;
- HTTPS source and final target only;
- YAML, plain-text, or octet-stream content types;
- UTF-8, one top-level YAML mapping, and typed collection shapes for proxies,
  groups, rules, and providers.

Readers must enforce limits while streaming so an oversized response is never
buffered without a bound. The pipeline repeats size, redirect, scheme, and
content-type checks after the reader returns. A future HTTPS adapter may use a
tokenized URL as supplied, but P0 does not add Basic, Bearer, or custom-header
credential forms.

The preview contains only a label, proxy/group/rule counts, source type, safe
warnings, and a sensitive-data notice. It never contains source bytes, a raw
URL, query parameters, proxy credentials, or parser excerpts.

## Configuration ownership

Preflight emits one classification for each imported setting that crosses an
ownership boundary. Activation must consume this classification; it must not
silently restore removed values.

The classification is a typed, display-safe runtime provenance report. Each
item contains only a bounded field identity, owning layer, disposition, reason,
activation impact, and whether the field was present in the source. It never
contains a configuration value, provider name, endpoint, URL token, node
content, or complete filesystem path. The report records its immutable source
revision and normalized-artifact fingerprint; repository validation rejects a
report attached to any other revision or artifact. Saved Profile details and
import preview render this report as the read-only sequence Source → User
patches → Application policy → Platform integration → Effective runtime.

Metadata schema 2 stores the complete report. Schema-1 records are loaded as a
revision-bound migrated policy baseline so existing last-known-valid Profiles
remain activatable; the UI identifies that baseline and asks for a refresh
before claiming source-field presence. A successful refresh persists the full
schema-2 report without mutating the prior immutable source revision.

| Source content                                                   | Owner       | P0 disposition |
| ---------------------------------------------------------------- | ----------- | -------------- |
| Proxies, groups, rules, providers, DNS, hosts, and unknown keys  | Source      | Preserved      |
| Ports, LAN bindings, Controller/UI settings, secrets, mode, logs | Application | Overridden     |
| `tun.enable`, `sniffer.enable`                                   | Platform    | Disabled       |
| DNS listen                                                       | Platform    | Overridden     |
| Profile selection persistence                                    | Source      | Preserved      |
| Profile fake-IP persistence                                      | Application | Overridden     |
| External UI, CORS, TLS, pipe, and Unix controller surfaces       | Application | Overridden     |
| Listeners, interface/routing marks                               | Platform    | Hard rejected  |
| Absolute or escaping proxy-provider and rule-provider paths      | Platform    | Hard rejected  |

Disabled nested flags are normalized to `false`; overridden keys are absent
from the normalized source layer. Relative provider paths remain source-owned.
Hard-rejected fields fail preflight with a safe wildcard field identity and no
source value. Application and platform layers supply reviewed values only
during activation. The preflight normalizer and runtime generator share the
same managed-field rule table, so UI classification cannot diverge from the
generated runtime behavior.

## App-local storage

The file-backed repository receives an app-local root from its host. It rejects
relative roots, non-canonical IDs, invalid persisted hashes, and symbolic links
within the managed layout.

```text
<app-local-root>/
  selected-profile.json
  profiles/
    <user-visible-name>.yaml
  profile-store/
    profiles/
      <profile-uuid>/
        metadata.json
        source/
          source.json
          revisions/
            <source-sha256>.yaml
        artifacts/
          <artifact-sha256>.yaml
        patches/
          index.json
          sets/
            <patch-set-sha256>.json
```

`profiles/` is the user-facing configuration seam. Every direct regular
`.yaml` or `.yml` file in that directory is a Profile; nested directories and
symbolic links are ignored. Saves and successful subscription refreshes
atomically materialize source bytes there. A one-second desktop reconciliation
loop detects external creates, changes, and deletes. It suppresses self-writes
by source revision, imports valid new files, retains last-known-good private
state when an edited file is invalid, and removes inactive records whose files
were deleted. Detaching a subscription keeps the same materialized file and
changes only its source and scheduling metadata.

`profile-store/` is a private implementation detail. UUIDs, immutable
revisions, normalized artifacts, and patch sets never determine the directory
opened by the configuration page.

`metadata.json` contains the redacted source summary, provenance hashes,
validation state, attempts, success, and status flags. `source/source.json`
contains the sensitive source descriptor, including a complete tokenized URL
when one is required for refresh. The authenticated Profiles snapshot reads that
descriptor so the configuration page can show the complete subscription address
as an explicit user-facing source locator. Logs, events, diagnostics, previews,
errors, and support bundles continue to use only redacted summaries. Revision
YAML and artifact YAML may also contain credentials and private names. Patch
state is private because typed rule values and user labels can still be
sensitive.

On Unix, managed directories are mode `0700` and atomically written files are
created as mode `0600`. These permissions are defense in depth, not encryption;
the host must choose the platform app-data location and may add operating-system
data protection later. Sensitive files must never be copied to logs, error
messages, clipboard payloads, or default diagnostics. The configuration page is
the deliberate exception for displaying the complete subscription URL; users
should expect it to be visible in screenshots of that page.

Initial save writes a private staging directory, fsyncs each temporary file,
renames files within their destination directory, fsyncs directories, and
publishes the complete profile directory with one rename. Updates write new
content-addressed revision and artifact files before atomically replacing
metadata, so a failed metadata write leaves the prior revision authoritative.
Corrupt JSON, missing files, fingerprint mismatches, schema mismatches, unsafe
paths, and atomic write failures return typed errors without echoing stored
contents.

Patch sets are content-addressed. Updates write the candidate set and metadata
before atomically replacing `patches/index.json`; that pointer is the patch
commit authority. A failed write therefore cannot make an unconfirmed patch set
available to activation, even when its candidate file was already staged.

## Structured patch layer

Patch schema 1 is a profile-scoped, revision- and artifact-fingerprint-bound
document stored independently from the immutable source. It accepts at most 128
ordered operations: typed common-rule prefix/suffix insertion, source-rule
disable/delete, selector-group creation, group-member replacement, and explicit
source-group ordering. References are opaque SHA-256 identities derived only
from safe entities in the current normalized revision. No ordinary command
accepts YAML, arbitrary configuration paths, scripts, templates, proxy protocol
definitions, source URLs, filesystem paths, Controller endpoints, or secrets.

Every operation has an opaque patch UUID, enabled state, explicit list order,
safe target summary, validation result/code, status, and activation impact.
User-authored Unicode labels are retained exactly. The editor replaces the
complete bounded draft only after validation; closing or cancelling never
persists draft state or changes the active runtime. Reset is represented by an
empty validated patch list and reconstructs the source-derived runtime.

Refresh never rewrites or silently drops a patch. The patch list is revalidated
against the new revision. A missing target or semantic conflict, including a
policy-group cycle, leaves the patch bound to the prior revision, marks the new
revision stale/invalid, and blocks its activation while the already active
last-known-valid runtime continues. A valid refresh rebinds the unchanged typed
operations and stores their newly generated effective fingerprint.

`RuntimeConfigGenerator` applies this shared patch engine before the existing
application managed-field policy and platform integration. Preview generation
and activation call the same record-based generator, so patch order and the
managed-field provenance contract cannot diverge.

## Application service

`ProfileService` owns the P0 operational flow over injected source readers and
the repository. It lists display-safe metadata, holds preflight previews only
as short-lived opaque in-memory entries, persists a selected preview, refreshes
an existing source, and deletes inactive profiles. Failed refresh stores the
safe failed attempt while retaining the last known valid revision and artifact.

Remote HTTPS profiles additionally persist an opt-in refresh policy. The
default is Off; the only enabled choices are six hours, twelve hours, daily,
and weekly. Local-file profiles reject enabled schedules. The application-level
coordinator, not the WebView, scans due timestamps once per minute and runs due
profiles serially. Manual refresh, scheduled refresh, and activation share one
per-profile ownership gate, so the same profile cannot be fetched or activated
concurrently. A scheduled failure retains the immutable last-known-valid
revision, artifact, and runtime provenance, records a display-safe failure
timestamp, and backs off by up to eight times the selected interval. A success
resets backoff and schedules from its confirmed completion time.

The desktop bridge exposes only HTTPS preflight and persisted-profile commands
through authenticated RPC. Local-file preflight remains outside ordinary RPC
and is composed through the user-mediated Tauri picker boundary. Neither the
service view nor its errors expose raw URLs, source YAML, credentials, or full
local paths.

Protocol version 15 adds authenticated `profiles.create`. It accepts only a
single bounded `.yaml` or `.yml` file name, creates a minimal direct-routing
profile without overwriting an existing file, reconciles it through the same
Profile validation pipeline, and returns the updated snapshot.

## Activation transaction seam

Activation remains outside the profile crate. The authenticated Profiles
command surface accepts only a command ID and persisted profile ID;
`ProfileActivationCoordinator` reloads that record through `ProfileService`,
which rechecks its valid state and artifact fingerprint before
`MihomoActivationManager` generates a runtime configuration. Ordinary RPC never
accepts configuration bytes, filesystem paths, Controller endpoints, or
Controller secrets. The manager then:

1. injects the application-owned loopback Controller, secret, managed mixed
   proxy endpoint, zero values for every unused ingress port, Rule mode, warning
   logging, and managed resource policy;
2. forces LAN, listeners, sniffer capture, and TUN off;
3. writes the complete generated configuration to a private candidate staging
   directory and validates it with pinned Mihomo v1.19.29;
4. restores confirmed System Proxy ownership when needed, stops the prior core,
   and starts the candidate from its own managed home on the single managed
   proxy endpoint;
5. requires the pinned Controller version plus the first complete valid Status
   and Traffic observations and, for previously explicit capture intent,
   confirms the proxy listener before reapplying System Proxy;
6. atomically commits a redacted managed active-state record, or stops the
   candidate and restores the prior healthy core and capture intent or an
   explicit safe stopped state; and
7. records only profile ID, fingerprint, outcome, and a closed failure category,
   and publishes a bounded application diagnostic built from that category.

The coordinator publishes a typed idle, pending, success, or failure snapshot.
Command IDs are idempotent, concurrent requests for the same target are
deduplicated, and pending activation supports explicit cancellation plus the
manager readiness deadline. Capture restoration has its own `capture` failure
category so the Web client does not discard that notification or replace it
with a generic activation error. Diagnostic guidance is selected from closed
failure categories and never includes a source URL, profile label, generated
configuration, Controller credential, or arbitrary backend error text.
`DesktopRuntimeHost` replaces the active
`MishRuntime` only after the managed activation transaction commits, so Status,
Traffic, and the active-profile projection cross the same boundary. Status,
Traffic, and Profiles subscriptions all resample authoritative state after a
runtime change or reconnect.

The desktop starts with the recorded `safe-stopped` policy. It does not infer,
import, or automatically restore a private profile, and activation never enables
System Proxy or TUN. Deleting the active profile first requires a successful
replacement activation or an explicit transition to the safe stopped state.

The managed activation record is separate from profile repository metadata.
Profiles RPC and view state project activation attempts from that record;
repository persistence alone never implies activation. This seam
also prevents an imported router or server configuration from silently enabling
System Proxy, TUN, listeners, or a Controller endpoint.
