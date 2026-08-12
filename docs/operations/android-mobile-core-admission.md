# Android Mobile Core admission

## Contract

The Android plugin checks the embedded Mobile Core admission under one probe
authority and fails closed before JNI loading, configuration validation/load, or
`VpnService` Core start. The admission input is the staged
`mish-mobile-core-admission.json` asset plus the packaged ABI-specific
`libmish_mobile_core.so` and the Android package-signature observation. The
result is a closed `admitted`/typed-rejection value; it is not persisted in
platform facts. The same decision updates one latest-only in-memory provenance
projection. Reading that projection never reopens the manifest, artifact, or
package signer and exposes no certificate bytes, paths, or native response text.

The pinned policy is:

| Fact                   | Required value                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mihomo source commit   | `e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`                                                                              |
| Mihomo version         | `v1.19.29`                                                                                                              |
| Wrapper revision       | `mish-mobile-core-v1`                                                                                                   |
| Wrapper contract       | `1`                                                                                                                     |
| Mobile Core ABI        | `1`                                                                                                                     |
| Supported ABIs         | `arm64-v8a`, `x86_64`                                                                                                   |
| Artifact digest        | exact lower-case SHA-256 from the selected build evidence                                                               |
| Signature scheme       | `android-package-signature-v1`                                                                                          |
| Signer policy          | `synthetic-debug-v1`                                                                                                    |
| Expected signer        | exact lower-case SHA-256 certificate fingerprint from the repository-owned debug/test JKS certificate                   |
| Signature verification | `package-signer` with exactly one non-empty APK signer (16 KiB cap), whose computed fingerprint equals the expected pin |

The staged manifest is generated from `mobile-core/source-manifest.json` and
the selected `SHA256SUMS`; it contains only these bounded facts. It is ignored
build input and is never a product diagnostic payload.

## Boundary matrix

| Effect                             | Owner                                                                                     | Invocation/result                                                                                                      | Recording and replay                                                                                                                                                                                                            | Privacy                                                                                                                                                     | Exclusion                                                                                                                     | Limit                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Read bounded admission manifest    | `MobileCoreArtifactAdmission`                                                             | `manifest-read` / `manifest-missing` or `manifest-malformed`                                                           | Version-2 closed manifest; pure `MobileCoreAdmissionPolicy` tests                                                                                                                                                               | Exact keys, 16 KiB cap, no paths or bytes                                                                                                                   | Asset is generated only by Android staging and ignored by Git                                                                 | Does not prove release packaging provenance by itself                                                     |
| Read ABI-specific Core bytes       | `MobileCoreArtifactAdmission`                                                             | `artifact-observe` / missing, truncated, oversized, or digest mismatch                                                 | SHA-256 over one bounded packaged `.so`; occurrence-bounded replay uses a shared synthetic artifact state                                                                                                                       | Digest or closed failure only; 128 MiB cap; no path in result                                                                                               | No `.so` is tracked; staging verifies ELF, symbols, and checksums                                                             | Does not prove ELF behavior or reproducibility on another host                                            |
| Select debug/test signer           | Gradle `mishFixtureDebug` config                                                          | `debug-signer-selected` or build failure                                                                               | The tracked, credential-free JKS and public DER certificate are one build/test authority; release has no reference to either                                                                                                    | Password, private-key bytes, and paths never enter facts, logs, snapshots, or DTOs                                                                          | Static Android gate rejects release references; the fixture is not a release/store credential                                 | Synthetic debug/test material does not prove real release signing or store identity                       |
| Verify packaged APK signer         | `scripts/verify-android-apk-signature.ts`                                                 | `apk-signer-match` or fail-closed missing/multiple/malformed/mismatch result                                           | CI runs `apksigner --print-certs` on every produced APK and compares exactly one lower-case SHA-256 digest to source manifest pin                                                                                               | Only bounded scheme names and digest are retained; raw tool output is not recorded                                                                          | CI package step and script tests enforce the comparison before upload                                                         | Does not prove PackageManager observation on an emulator/device                                           |
| Observe APK signer                 | `MobileCoreArtifactAdmission`                                                             | `signature-observed` / `signature-missing`, `signature-unverified`, or `signer-fingerprint-mismatch`                   | `PackageManager` signer bytes are reduced to a lower-case SHA-256 fingerprint; policy replay uses the public certificate fixture and the pinned source-manifest value                                                           | Certificate bytes never enter facts, logs, snapshots, or DTOs                                                                                               | No runtime signing key/certificate or external service is required                                                            | Synthetic fingerprint evidence does not prove real release signing or store identity                      |
| Recheck artifact at protected use  | `MobileCoreArtifactAdmission`                                                             | `protected-use-recheck` / accepted or replaced                                                                         | The same admission authority re-observes the packaged artifact immediately before the first JNI shim/Core load; the deterministic replacement case mutates only the shared synthetic artifact state on observation occurrence 2 | Closed accepted/replaced result only; no bytes, path, or arbitrary failure text                                                                             | The seam is Kotlin-internal; adversarial sources and occurrence controls exist only in JVM tests                              | Does not prove an immutable filesystem handle or physical-device package behavior                         |
| Probe native ABI/version envelope  | `MishMobileCoreProbe`                                                                     | `probe` / typed ABI, source, version, or wrapper rejection                                                             | Existing bounded JNI tuple and exact JSON envelope parser                                                                                                                                                                       | Only pinned identity fields cross the boundary                                                                                                              | JNI is loaded only after admission; no command symbol is resolved                                                             | Does not prove device/emulator, Core networking, or TUN behavior                                          |
| Project latest provenance decision | `MishMobileCoreProbe` → `MobileCoreProvenanceProjection` → Kotlin plugin/Tauri/TypeScript | schema v1, authority/generation, admitted/rejected/not-evaluated, one closed classification, verified bounded evidence | The exact `MobileCoreAdmissionResult` updates a latest-only in-memory projection; `get_core_provenance` reads it without re-observation                                                                                         | Closed keys/enums and fixed commit/digest/signer formats; no paths, bytes, subjects, arbitrary text/maps, configuration, subscriptions, nodes, or inventory | The product DTO is reachable only through the mobile plugin command; synthetic controls and transcripts stay Kotlin test-only | Proves deterministic projection, not package contents, PackageManager/device behavior, or release signing |

## D2.3 diagnostic boundary matrix

| Effect                | Owner and real path                                       | Invocation/result                                                                       | Deterministic use case                                                  | Privacy/exclusion                                                   | Limit                                                   |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Admission decision    | `MobileCoreArtifactAdmission` under `MishMobileCoreProbe` | exact D2.1/D2.2 observation/evaluation result                                           | admitted plus every closed rejection classification                     | no duplicate parser, signer read, artifact read, or admission store | same packaging/device limits as admission evidence      |
| Diagnostic projection | `MobileCoreProvenanceProjection`                          | latest-only authority ID, monotonic generation, state/classification, optional evidence | not evaluated, admitted, rejected, authority replacement                | in-memory only; no history or arbitrary record keys/strings         | not a lifecycle, notification, or persistence authority |
| Mobile native command | Kotlin `getCoreProvenance` → Rust `get_core_provenance`   | strict schema-v1 DTO                                                                    | repeated read without increasing admission observations                 | typed command only; raw Kotlin/native errors do not cross           | no desktop or public RPC surface                        |
| TypeScript consumer   | `MobileVpnFixtureClient.getCoreProvenance`                | strict Zod parse; React may render/copy values unchanged                                | unknown field, nested certificate bytes, and oversized digest rejection | React does not classify validity or policy                          | no new public UI is required by Issue #454              |

An installed mobile consumer inspects this through
`plugin:mish-vpn|get_core_provenance`. The DTO is not added to desktop RPC,
Events, support bundles, persistent platform facts, or a generic diagnostics
framework.

## Deterministic use cases

The JVM policy tests cover the nominal path, the D2.1 critical rejections, and
the complete bounded D2.2 adversarial matrix:

- complete pinned manifest, supported ABI, exact artifact digest, and the
  expected debug/test certificate fingerprint admit;
- source commit, version, wrapper revision, ABI, artifact digest, signer
  scheme, expected signer fingerprint, and signer verification drift reject
  before native admission; and
- a differently signed synthetic APK fingerprint, missing signer, multiple
  signers, malformed certificate bytes, or malformed fingerprint rejects before
  the native/effect count can increase; and
- malformed manifest fields and unknown artifact keys reject under exact-key
  parsing; missing, malformed, unknown, and duplicate manifest or artifact
  facts all reject;
- unsupported or mismatched ABI, missing/truncated/oversized/replaced artifact,
  digest mismatch, missing/multiple/malformed/mismatched/unverified signer, and
  occurrence-2 replacement at the protected-use recheck all reject; and
- every rejection runs through the real admission gate vocabulary and proves
  zero JNI load, validate, load, start, inspect, VPN/TUN, or other runtime
  effect count. The boundary transcript is capped at 16 closed enum pairs and
  contains no path, certificate bytes, credentials, configuration, raw output,
  or arbitrary strings.

These tests exercise the admission authority with synthetic, credential-free
inputs and the checked-in public debug certificate fixture. The debug APK build
uses the paired test-only JKS through the `mishFixtureDebug` Gradle config, and
the package gate verifies the resulting APK certificate digest against the same
source-manifest pin. They do not claim PackageManager observation on an
emulator/physical device, real APK distribution, package-store acceptance,
release signing, or network acceptance. The JKS is deliberately a public,
non-production test key fixture with no protected release credential; it is not
a release/store certificate identity.
D2.3 exposes only the product DTO above. The D2.2 transcript remains
Kotlin-internal test evidence and is not copied into logs, errors, Events,
support bundles, or React. Named D2.3 cases cover admitted, not evaluated,
every closed rejection classification, process authority replacement, stable
repeated reads, strict unknown-field rejection, digest/record bounds, and
diagnostic privacy. Existing mobile snapshot delivery tests continue to own
stale/equal/duplicate event and runtime-replacement behavior; this latest-only
diagnostic read creates no second delivery authority.
