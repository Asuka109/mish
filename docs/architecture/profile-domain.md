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

## Future activation transaction seam

Activation remains intentionally outside this slice. A future application
service will accept a persisted, valid artifact and its policy classifications,
then:

1. inject application-owned Controller, port, logging, and resource policy;
2. inject explicitly approved platform capture policy;
3. validate the complete generated artifact against the pinned Mihomo core;
4. stage the candidate without replacing the last-known-good runtime;
5. commit the core switch and active-profile metadata as one application
   transaction, or roll back to the previous healthy artifact or a documented
   stopped state;
6. record the attempt and update last success only after the transaction
   commits.

This seam prevents repository persistence from implying activation and prevents
an imported router or server configuration from silently enabling System Proxy,
TUN, listeners, or a Controller endpoint.
