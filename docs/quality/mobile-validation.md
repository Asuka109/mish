# React Native Validation

The mobile gate validates a thin React Native host around the shared
TypeScript contracts and actors.

## Required checks

```sh
pnpm mobile:check
pnpm mobile:android:build
```

The debug build targets both `arm64-v8a` and `x86_64`. The owned admission
smoke runs on a root-free emulator and requires `RN_ADMISSION_OK`. It records
bounded process/serial cleanup and fails if a test leaves a build process,
serial transport, port `5558`, emulator, or temporary artifact behind.

The host boundary test rejects DOM imports, Web-only Store adapters, old native
paths, and browser globals from the RN graph. Native code may provide only an
irreducible effect seam; product lifecycle, session authority, and Query
projection remain shared TypeScript concerns.

## Evidence limits

This gate is credential-free and replayable. It does not claim a real
permission grant, VPN/TUN attachment, device network, serial hardware, or
external service behavior. A missing effect is represented by a typed
unavailable result, not a compatibility or fallback client.
