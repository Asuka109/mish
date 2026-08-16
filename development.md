# Development

## Prerequisites

- Node.js and pnpm versions declared by the repository package metadata;
- Java 17 and Android SDK components when running the React Native Android
  gate;
- macOS only for the Electron DMG fixture gate.

No additional language toolchain is part of the product workspace.

## Install and inspect

```sh
pnpm install --frozen-lockfile
pnpm check:pr
pnpm check:graph
pnpm poc:admission
```

`check:graph` walks the production entries and rejects retired protocols,
native-shell paths, stale session authorities, and imports into `poc/`.
`poc:admission` reads only the isolated POC admission metadata and never runs
POC code.

## Product gates

```sh
pnpm web:build
pnpm --filter @mish/web typecheck
pnpm --filter @mish/web test:run
pnpm desktop:check
pnpm desktop:bundle:fixture
pnpm mobile:check
pnpm mobile:android:build
```

The Web gate covers the six product destinations with replayed oRPC data. The
Electron gate covers host security, type checks, tests, and a disposable
credential-free DMG fixture. The React Native gate covers the shared host
boundary, tests, and a dual-ABI debug APK. None of these commands grants real
permissions, attaches a system interface, starts a VPN, or writes external
state.

## Editing and review

Contracts change first in `packages/contracts`; transport changes stay in
`packages/orpc-client`; complex lifecycle belongs in XState actors; Query and
Store remain projections/presentation. Add transcript fixtures and replay for
effect-boundary behavior. Keep `poc/` read-only and out of the production
workspace. Run `pnpm check:format` and the focused package gate before review.
