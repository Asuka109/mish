# macOS updater contract

## Stage 1 boundary

Mish owns update selection and verification instead of exposing Tauri's updater
plugin directly to the Web layer. Stage 1 is deliberately `contract-only`: it
defines authenticated inputs and returns a `VerifiedUpdate`, but it has no
endpoint configuration, network client, download command, installation
operation, application replacement, relaunch, or System Proxy handoff.

The desktop release-profile probe reports this boundary as `updater:
contract-only`. It must not be interpreted as a working update path.

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
public key or channel endpoint exists yet. A later live-release change must
configure the protected updater signing key, ship the matching public key,
enable this overlay, and add the four verified assets to the existing #173
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
Durable storage of that state belongs with the later download/install
transaction and is not simulated here.

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

## Later live boundaries

The following remain unavailable and require separate review and hands-on
acceptance:

- updater signing-key custody and rotation;
- production public-key and channel endpoint configuration;
- bounded, cancellable, restartable download;
- durable replay state and download recovery;
- pre-replacement System Proxy reconciliation and recovery authority;
- application replacement, rollback, and prior-app preservation;
- relaunch and expected-version observation; and
- two-version signed Alpha/stable upgrade and failure testing.

The existing signed-direct DMG remains the direct-distribution artifact. This
contract does not change Apple Developer ID, notarization, stapling,
Gatekeeper, tag, Draft Release, or publication status.
