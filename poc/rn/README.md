# React Native admission fixture

This package is a bounded React Native 0.87 New Architecture/Hermes admission
fixture. It consumes the public entries of `@mish/poc-orpc`,
`@mish/poc-query-store`, and `@mish/poc-xstate`; it does not enter a production
workspace graph and has no fallback or dual-write path.

The Android app uses one Kotlin TurboModule seam, `MishRnAdmission`. The seam
returns fixed capability facts and a fixed smoke marker only. It has no
permission, service, process, filesystem, VPN, TUN, Core, or network effect.

## Deterministic evidence

From `poc/` after a frozen install:

```sh
pnpm --filter @mish/poc-rn exec tsc --noEmit
pnpm --filter @mish/poc-rn exec vitest run
node poc/rn/scripts/check-admission.ts
node poc/rn/scripts/replay-transcript.ts
```

The replay emits a bounded semantic transcript covering WebSocket cancellation
and reconnect, AbortSignal cancellation, AsyncIterable `return()` cleanup, the
Query sink, and a real XState v5 actor. It is a closed in-memory model and does
not prove a real network or host effect.

## Android evidence

The package contains a Gradle wrapper and explicit arm64-v8a/x86_64 debug ABI
filters. Build and inspect the dual-ABI APK with:

```sh
node poc/rn/scripts/build-debug-apk.ts
node poc/rn/scripts/smoke-emulator.ts
```

The smoke script installs the debug APK on a root-free Android emulator,
launches `MainActivity`, waits for the real RN renderer to display
`RN_ADMISSION_OK`, checks the bounded log window for fatal exceptions, and
force-stops the fixture. The evidence does not claim physical-device,
production-signing, release, VPN/TUN/Core, or real-network behavior.

The RN renderer probe deliberately uses `useSyncExternalStore` through the
Mish Store adapter and is wrapped in `StrictMode`. The visible `store:ready:2`
state depends on batched updates reaching the actual RN renderer; package-only
Vitest tests are not used as a substitute for that renderer evidence.
