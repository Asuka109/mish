# Android Mobile Core admission

## Contract

The Android plugin checks the embedded Mobile Core admission under one probe
authority and fails closed before JNI loading, configuration validation/load, or
`VpnService` Core start. The admission input is the staged
`mish-mobile-core-admission.json` asset plus the packaged ABI-specific
`libmish_mobile_core.so` and the Android package-signature observation. The
result is a closed `admitted`/typed-rejection value; it is not persisted in
platform facts and it does not expose certificate bytes, paths, or native
response text.

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

| Effect                            | Owner                                     | Invocation/result                                                                                    | Recording and replay                                                                                                                                                  | Privacy                                                                            | Exclusion                                                                                     | Limit                                                                                |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Read bounded admission manifest   | `MobileCoreArtifactAdmission`             | `manifest-read` / `manifest-missing` or `manifest-malformed`                                         | Version-2 closed manifest; pure `MobileCoreAdmissionPolicy` tests                                                                                                     | Exact keys, 16 KiB cap, no paths or bytes                                          | Asset is generated only by Android staging and ignored by Git                                 | Does not prove release packaging provenance by itself                                |
| Read ABI-specific Core bytes      | `MobileCoreArtifactAdmission`             | `artifact-read(abi)` / `artifact-missing` or `artifact-digest-mismatch`                              | SHA-256 over one bounded packaged `.so`; policy replay uses synthetic digests                                                                                         | Digest only; 128 MiB cap; no path in result                                        | No `.so` is tracked; staging verifies ELF, symbols, and checksums                             | Does not prove ELF behavior or reproducibility on another host                       |
| Select debug/test signer          | Gradle `mishFixtureDebug` config          | `debug-signer-selected` or build failure                                                             | The tracked, credential-free JKS and public DER certificate are one build/test authority; release has no reference to either                                          | Password, private-key bytes, and paths never enter facts, logs, snapshots, or DTOs | Static Android gate rejects release references; the fixture is not a release/store credential | Synthetic debug/test material does not prove real release signing or store identity  |
| Verify packaged APK signer        | `scripts/verify-android-apk-signature.ts` | `apk-signer-match` or fail-closed missing/multiple/malformed/mismatch result                         | CI runs `apksigner --print-certs` on every produced APK and compares exactly one lower-case SHA-256 digest to source manifest pin                                     | Only bounded scheme names and digest are retained; raw tool output is not recorded | CI package step and script tests enforce the comparison before upload                         | Does not prove PackageManager observation on an emulator/device                      |
| Observe APK signer                | `MobileCoreArtifactAdmission`             | `signature-observed` / `signature-missing`, `signature-unverified`, or `signer-fingerprint-mismatch` | `PackageManager` signer bytes are reduced to a lower-case SHA-256 fingerprint; policy replay uses the public certificate fixture and the pinned source-manifest value | Certificate bytes never enter facts, logs, snapshots, or DTOs                      | No runtime signing key/certificate or external service is required                            | Synthetic fingerprint evidence does not prove real release signing or store identity |
| Probe native ABI/version envelope | `MishMobileCoreProbe`                     | `probe` / typed ABI, source, version, or wrapper rejection                                           | Existing bounded JNI tuple and exact JSON envelope parser                                                                                                             | Only pinned identity fields cross the boundary                                     | JNI is loaded only after admission; no command symbol is resolved                             | Does not prove device/emulator, Core networking, or TUN behavior                     |

## Deterministic use cases

The JVM policy tests cover the nominal path and the D2.1 critical rejections:

- complete pinned manifest, supported ABI, exact artifact digest, and the
  expected debug/test certificate fingerprint admit;
- source commit, version, wrapper revision, ABI, artifact digest, signer
  scheme, expected signer fingerprint, and signer verification drift reject
  before native admission; and
- a differently signed synthetic APK fingerprint, missing signer, multiple
  signers, malformed certificate bytes, or malformed fingerprint rejects before
  the native/effect count can increase; and
- malformed manifest fields and unknown artifact keys reject under exact-key
  parsing.

These tests exercise the admission authority with synthetic, credential-free
inputs and the checked-in public debug certificate fixture. The debug APK build
uses the paired test-only JKS through the `mishFixtureDebug` Gradle config, and
the package gate verifies the resulting APK certificate digest against the same
source-manifest pin. They do not claim PackageManager observation on an
emulator/physical device, real APK distribution, package-store acceptance,
release signing, or network acceptance. The JKS is deliberately a public,
non-production test key fixture with no protected release credential; it is not
a release/store certificate identity.
D2.2 retains the exhaustive replacement,
manifest, ABI, and artifact adversarial matrix; D2.3 owns any public redacted
provenance diagnostics.
