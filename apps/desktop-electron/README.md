# Mish Electron host foundation

This package is a secure desktop shell foundation for the existing Mish Web
renderer. It does not contain product state, the Rust runtime, the desktop
bridge, Mihomo, System Proxy, TUN, Helper, updater, or release credentials.

The main process owns only Electron window/session lifecycle and a bounded
semantic lifecycle transcript. The preload exposes two explicit, typed IPC
methods through `contextBridge`; it never exposes `ipcRenderer`, Node globals,
or arbitrary channel forwarding. The renderer continues to use the production
`apps/web` build and existing contracts. The current shell reports all
application capabilities as unavailable until a separately composed backend is
provided.

## Commands

- `pnpm --filter @mish/desktop-electron build` builds the production Web bundle
  and the Electron host.
- `pnpm --filter @mish/desktop-electron test:run` runs deterministic policy,
  IPC, lifecycle, and production-exclusion smoke tests without launching an
  Electron window or mutating a host.
- `pnpm --filter @mish/desktop-electron package:dmg:fixture` creates a local,
  ad-hoc-signed macOS fixture at
  `target/desktop-electron/Mish-Electron-Foundation-fixture.dmg`. It requires
  macOS tools and uses no Developer ID, notarization, publication, or deploy
  credentials.

The DMG fixture proves only the closed app/resource layout, ad-hoc signature
shape, Finder-template contract, and read-only image verification. It does not
prove bridge startup, a real Mihomo process, System Proxy/TUN/Helper effects,
network behavior, notarization, updater installation, or release policy.
Its bundle contains an inert local Mach-O executable rather than a downloaded
Electron runtime, so the fixture is intentionally not a launchable release app.
