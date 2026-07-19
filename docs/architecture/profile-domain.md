# Profile domain, preflight, and persistence

## Decision

`crates/profile` owns the transport- and UI-independent Profile domain. It
defines source identity, provenance, immutable revisions, normalized artifacts,
stable fingerprints, validation results, lifecycle attempts, last success, and
the active/valid/stale/updating/warning/error status vocabulary. It does not
render Profiles UI, call Tauri, start Mihomo, activate capture, or depend on the
Controller client.

An imported YAML document is never treated as both user policy and desktop
application state. The crate retains the received bytes as an immutable source
revision and creates a separate normalized runtime artifact. Normalization
preserves syntactically valid unknown YAML values semantically, but does not
promise byte-for-byte formatting, comments, anchors, or in-place editing. Every
successful preflight therefore reports this limitation and keeps the immutable
source.

## Domain vocabulary

| Term                 | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `ProfileSource`      | A validated absolute local-file path or HTTPS URL. URL user-info and fragments are rejected. |
| `Provenance`         | Safe source summary, import timestamp, and immutable source revision ID.                     |
| `ImmutableRevision`  | SHA-256-addressed received bytes plus size, media type, and creation time.                   |
| `NormalizedArtifact` | Generated YAML, its schema version, source revision, size, and SHA-256 fingerprint.          |
| `ValidationResult`   | Typed valid/invalid outcome with safe warnings and errors.                                   |
| `ProfileAttempt`     | Timestamp and success/failure of the latest lifecycle attempt.                               |
| `ProfileSuccess`     | Timestamp, revision, and fingerprint of the last known valid result.                         |
| `ProfileStatus`      | Independent active, valid, stale, updating, warning, and error flags for later view mapping. |

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

| Source content                                                   | Owner       | P0 disposition |
| ---------------------------------------------------------------- | ----------- | -------------- |
| Proxies, groups, rules, providers, DNS, hosts, and unknown keys  | Source      | Preserved      |
| Ports, LAN bindings, Controller/UI settings, secrets, mode, logs | Application | Overridden     |
| `tun.enable`                                                     | Platform    | Disabled       |
| Listeners, interface/routing marks                               | Platform    | Rejected       |
| Absolute proxy-provider or rule-provider paths                   | Platform    | Rejected       |

`tun.enable` is normalized to `false`; rejected and overridden keys are absent
from the normalized source layer. Relative provider paths remain source-owned.
Application and platform layers may supply reviewed values only during the
future activation transaction.

## App-local storage

The file-backed repository receives an app-local root from its host. It rejects
relative roots, non-canonical IDs, invalid persisted hashes, and symbolic links
within the managed layout.

```text
<app-local-root>/
  profiles/
    <profile-uuid>/
      metadata.json
      source/
        source.json
        revisions/
          <source-sha256>.yaml
      artifacts/
        <artifact-sha256>.yaml
```

`metadata.json` is the ordinary display-safe document. It contains the redacted
source summary, provenance hashes, validation state, attempts, success, and
status flags. `source/source.json` contains the sensitive source descriptor,
including a complete tokenized URL when one is required for manual refresh.
Revision YAML and artifact YAML may also contain credentials and private names.
The three categories are deliberately separate so ordinary profile listing and
diagnostics need read only metadata. The repository's listing API returns only
validated metadata and never opens source descriptors or YAML artifacts.

On Unix, managed directories are mode `0700` and atomically written files are
created as mode `0600`. These permissions are defense in depth, not encryption;
the host must choose the platform app-data location and may add operating-system
data protection later. Sensitive files must never be copied to logs, error
messages, screenshots, clipboard payloads, or default diagnostics.

Initial save writes a private staging directory, fsyncs each temporary file,
renames files within their destination directory, fsyncs directories, and
publishes the complete profile directory with one rename. Updates write new
content-addressed revision and artifact files before atomically replacing
metadata, so a failed metadata write leaves the prior revision authoritative.
Corrupt JSON, missing files, fingerprint mismatches, schema mismatches, unsafe
paths, and atomic write failures return typed errors without echoing stored
contents.

## Application service

`ProfileService` owns the P0 operational flow over injected source readers and
the repository. It lists display-safe metadata, holds preflight previews only
as short-lived opaque in-memory entries, persists a selected preview, refreshes
an existing source, and deletes inactive profiles. Failed refresh stores the
safe failed attempt while retaining the last known valid revision and artifact.

The desktop bridge exposes only HTTPS preflight and persisted-profile commands
through authenticated RPC. Local-file preflight remains outside ordinary RPC
and is composed through the user-mediated Tauri picker boundary. Neither the
service view nor its errors expose raw URLs, source YAML, credentials, or full
local paths.

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
7. records only profile ID, fingerprint, outcome, and a closed failure category.

The coordinator publishes a typed idle, pending, success, or failure snapshot.
Command IDs are idempotent, concurrent requests for the same target are
deduplicated, and pending activation supports explicit cancellation plus the
manager readiness deadline. `DesktopRuntimeHost` replaces the active
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
