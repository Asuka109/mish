# Mish React Native Android foundation

This package is an isolated React Native 0.87 Android application running the
New Architecture (`newArchEnabled=true`) beside the existing Tauri mobile
application. It owns a small TypeScript UI shell with five accessible mobile
destinations (Home, Routes, Profiles, Activity, and Settings), while native
code owns only the typed capability boundary.

The Kotlin `MishCapability` TurboModule is deliberately effect-free in this
foundation slice. Its codegen specification accepts only bounded capability
requests and bounded request identities. Known capabilities return an honest
`unavailable` / `not-implemented` result; unknown capabilities and malformed
identities are rejected before any native work. The Kotlin contract records a
closed semantic invocation/result event for each deterministic test decision.
There is no VPN/TUN/Core start, socket protection, foreground service,
permission prompt, network mutation, or Web-to-native navigation channel.

The UI consumes the platform-neutral tokens exported by
`@mish/design-tokens/native` and uses the existing `@mish/contracts` package
for mobile platform/phase types. Android system density, typography, and
system-bar behavior remain platform concerns.

## Local verification

From the repository root, install the workspace first:

```sh
pnpm install
pnpm --filter @mish/mobile-rn android:check
pnpm --filter @mish/mobile-rn typecheck
pnpm --filter @mish/mobile-rn test:run
pnpm --filter @mish/mobile-rn android:test
pnpm --filter @mish/mobile-rn android:build
pnpm --filter @mish/mobile-rn android:inspect
```

`android:build` runs Codegen and produces credential-free, split debug APKs
for `arm64-v8a` and `x86_64`. The build uses the repository-owned synthetic
`mishFixtureDebug` JKS only for debug/test artifacts. The inspector verifies
the package ID (`com.asuka109.mish.rn`), INTERNET-only manifest, exact pinned
debug signer, and both ABI outputs. It does not prove real device behavior,
VPN permission, TUN setup, Core lifecycle, socket protection, packet flow, or
release signing.

`android:install` installs the ARM64 debug split on a compatible connected
device/emulator only after the build has been inspected. Physical-device
acceptance is outside this task and must not be inferred from the local APK
checks.
