# Bootstrap

The supported local bootstrap is intentionally narrow:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check:pr
```

For the Android host gate, install Java 17, Android SDK platform 36, build
tools 36.1.0, and platform-tools. Then run:

```sh
pnpm mobile:check
pnpm mobile:android:build
```

The Android build emits a debug APK for `arm64-v8a` and `x86_64`; admission
requires a root-free emulator replay and `RN_ADMISSION_OK`. A real device,
serial transport, permission prompt, VPN, TUN, or network effect is outside
the automated gate.

On macOS, the Electron fixture gate is:

```sh
pnpm desktop:check
pnpm desktop:bundle:fixture
```

It uses a disposable application fixture, verifies the Finder presentation,
and cleans its temporary mount and process state. It is not a distribution or
signing workflow.
