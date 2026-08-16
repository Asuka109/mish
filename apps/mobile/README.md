# Mish React Native host

This package owns the React Native 0.87 New Architecture/Hermes host under
`android/`. Its product composition uses the shared contracts, oRPC session
authority, XState actors, TanStack Query core, and framework-agnostic Mish UI
state. The Android seam reports deterministic capability facts only; it does
not request permission, create a VPN/TUN interface, start a core process, open
a real network connection, or own product lifecycle state.

Run the bounded checks with:

```sh
pnpm --filter @mish/mobile rn:typecheck
pnpm --filter @mish/mobile rn:test:run
pnpm --filter @mish/mobile rn:android:build
pnpm --filter @mish/mobile rn:android:smoke
```

The debug APK is restricted to `arm64-v8a` and `x86_64`. The renderer smoke
check admits only the `RN_ADMISSION_OK` marker on an unprivileged owned
emulator. These commands provide Android debug/admission evidence only; they
do not claim iOS, physical-device, distribution, store signing, or real
network/VPN behavior.
