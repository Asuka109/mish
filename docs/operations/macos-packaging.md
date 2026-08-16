# macOS DMG Fixture

The macOS packaging gate is a bounded Electron fixture, not a distribution
workflow. `apps/desktop/scripts/electron-fixture.ts` assembles a disposable
application, and `scripts/macos-dmg-presentation.ts` verifies the Finder
presentation contract.

## Contract

- the volume is named `Mish`;
- only `Mish.app` and the `/Applications` alias are visible;
- the checked background and Finder metadata are hash-locked;
- mounting is read-only and does not open Finder or launch an application;
- an existing output is moved to trash only when replacement was explicitly
  requested;
- temporary directories, processes, and mounts are cleaned before the command
  exits.

Run:

```sh
pnpm desktop:check
pnpm desktop:bundle:fixture
```

The fixture is credential-free. It does not sign, notarize, publish, deploy,
or exercise a real system network effect. A successful fixture proves layout,
bounded cleanup, and deterministic replay only.
