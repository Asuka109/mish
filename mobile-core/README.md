# Mish Mobile Core

This directory contains the platform-neutral Mobile Core ABI, a deterministic C
fixture, the GPL-licensed Go reference wrapper, the pinned source manifest, and
text-only Android build evidence. It does not contain Android `VpnService`, JNI,
application shell, or native library binaries.

## Inputs

- Mihomo `v1.19.29` at commit
  `e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`;
- official Go `go1.26.0`, with per-host archive hashes in
  `source-manifest.json`;
- Android NDK `29.0.14206865`;
- API 28 Clang targets for `arm64-v8a` and `x86_64`; and
- build tags `cmfa,with_gvisor`.

The build verifies that the stable tag resolves to the pinned commit and tree.
It uses a local exact source checkout through a temporary Go module replacement;
it never downloads or links a third-party prebuilt AAR or native library.

## Commands

```sh
pnpm mobile-core:contract
pnpm mobile-core:build
pnpm mobile-core:verify
```

`mobile-core:build` downloads the pinned official Go archive when necessary,
verifies its SHA-256, checks or creates an exact Mihomo source checkout, builds
both Android ABIs twice into different output paths, and fails if their bytes or
v1 symbols differ. Set `MISH_GO_ROOT`, `ANDROID_NDK_HOME`, `--source-dir`,
`--scratch-dir`, or `--evidence-dir` only to point at equivalent pinned inputs.

Build outputs remain under `.scratch` and are ignored by Git. The committed
evidence directory contains only checksums, provenance, the ABI symbol baseline,
GPL notice, disk measurements, and an SPDX 2.3 SBOM. To reclaim build space:

```sh
trash .scratch/mobile-core
```

Never copy the resulting `.so` files into the repository. A later Android
integration task may stage verified build outputs into generated packaging
directories without making those binaries source-controlled.

The ABI contract is
[`../docs/architecture/mobile-core-abi.md`](../docs/architecture/mobile-core-abi.md).
