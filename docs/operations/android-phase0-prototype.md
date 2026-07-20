# Android Phase 0 Prototype

## Scope and claim boundary

Phase 0 packages the standalone Mish mobile shell with a typed Tauri native
fixture and a Kotlin `VpnService` lifecycle prototype. The shell has Home,
Routes, Profiles, Activity, and Settings as its five primary destinations. It
does not reuse the desktop loopback bridge or a desktop sidecar.

The Android prototype requests VPN consent only after an explicit user action,
uses a protected foreground service and honest notification, serializes
lifecycle transitions, and publishes versioned snapshots and events across
Activity or WebView recreation. Its replaceable fixture backend reports VPN
capability as unavailable. An explicitly staged, checksum-matched native Core
may report its ABI and version identity through a bounded JNI probe, but the
fixture never initializes or starts it. It never calls
`VpnService.Builder.establish`, creates a TUN, captures traffic, or starts
Mihomo. No subscription, token, node, or user configuration is included. This
work proves the **compiled shell** evidence
level and part of the **native fixture** level defined by
[`../quality/mobile-validation.md`](../quality/mobile-validation.md). It does
not prove an **installable app** because no Android device or emulator was
connected for installation and launch, and it does not prove a device VPN.

## Verified upstream requirements

The toolchain and project pins were checked on 2026-07-20 against the following
official sources:

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) require the
  Android SDK Platform, Platform Tools, NDK, Build Tools, command-line tools,
  Android Rust targets, and the Java, SDK, and NDK environment variables.
- [Tauri CLI reference](https://v2.tauri.app/reference/cli/) documents
  `android init`, `android build`, debug builds, target selection, and
  per-ABI output.
- [Set up the Android 16 SDK](https://developer.android.com/about/versions/16/setup-sdk)
  requires compile and target SDK 36 and recommends the latest 36.x Build
  Tools.
- [Java versions in Android builds](https://developer.android.com/build/jdks)
  requires JDK 17 for Android Gradle Plugin 8.x.
- [Install and configure the NDK](https://developer.android.com/studio/projects/install-ndk#apply-specific-version)
  recommends pinning `ndkVersion` for reproducible builds.
- [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)
  make edge-to-edge and predictive back the target-36 defaults. The shell keeps
  edge-to-edge inset handling and uses AndroidX back dispatch without an opt-out.
- [`VpnService`](https://developer.android.com/reference/android/net/VpnService)
  requires explicit `prepare()` consent, a service protected by
  `BIND_VPN_SERVICE`, foreground promotion on Android 8+, and conservative
  cleanup from `onRevoke()`.
- [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
  list configured VPN applications under `systemExempted`; the Manifest and
  runtime `startForeground` type match and the service starts only after consent.
- [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission)
  does not gate foreground-service startup, but the application requests it in
  context so the persistent status can appear in the notification drawer.
- [Tauri mobile plugin development](https://v2.tauri.app/develop/plugins/develop-mobile/)
  defines Kotlin commands, activity-result callbacks, lifecycle hooks, and
  typed plugin events used by the local `mish-vpn` plugin.

## Lifecycle and recovery contract

- `VpnService.prepare()` is evaluated without showing UI during snapshot
  reconciliation. Its returned consent activity is launched only by the visible
  **Review VPN permission** command.
- Consent success never starts the service. The user must separately run the
  lifecycle check, and the service rechecks consent before foreground startup.
- `MishVpnService` owns a single-thread executor. Start, stop, revoke,
  destruction, and recovery transitions cannot mutate lifecycle state in
  parallel.
- Snapshots persist a session identifier and globally increasing sequence.
  WebView listeners reject older sequences and request a complete snapshot on
  bootstrap before accepting later events.
- A persisted `starting`, `running`, or `stopping` phase after process creation
  becomes `recovery-required`. Consequential commands are never replayed after
  an unknown outcome.
- The production Phase 0 wiring uses `FixtureVpnBackend`. Its start operation
  always returns `unavailable`; the honest fixture notification remains
  foreground only until explicit stop, revoke, or destruction. `vpnActive`
  remains false throughout. Core availability describes only verified package
  identity and does not imply initialization, TUN ownership, or traffic capture.

## Retained local toolchain

The machine started with no Android SDK or JDK. The retained set is deliberately
limited to one JDK, one Android platform, one Build Tools version, Platform
Tools, one NDK, and the two required Android Rust standard libraries:

| Component                            | Retained version         |                Measured size |
| ------------------------------------ | ------------------------ | ---------------------------: |
| OpenJDK                              | 17.0.19                  |                  312,500 KiB |
| Android command-line tools           | 14742923                 |                  169,580 KiB |
| Android SDK root                     | API 36 package set below |                3,608,916 KiB |
| Rust ARM64 Android standard library  | stable toolchain         |                  142,032 KiB |
| Rust x86_64 Android standard library | stable toolchain         |                  143,572 KiB |
| **Retained total**                   |                          | **4,376,600 KiB (4.17 GiB)** |

The Android SDK root contains only:

- `platforms;android-36` revision 2;
- `build-tools;36.1.0`;
- `platform-tools` 37.0.0; and
- `ndk;29.0.14206865`.

No emulator or system image was installed. A transient Build Tools 35.0.0
package requested during the first Gradle bootstrap was removed, as were the
unused ARMv7 and i686 Rust targets. The retained footprint is below the 15 GiB
budget; build intermediates and dependency caches are not part of the retained
toolchain.

## Reproducible setup and build

Install the exact Android package set with `sdkmanager --sdk_root` and retain no
additional versions. Then export:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"
```

Initialize the committed Tauri Android project inputs and reapply the pinned
Gradle settings:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
pnpm mobile:android:init
pnpm check:android
```

Build one debug APK per ABI:

```sh
pnpm mobile-core:build
pnpm mobile-core:stage:android
pnpm mobile:android:build
```

The staging command rejects missing, wrong-architecture, wrong-symbol, or
checksum-mismatched Core artifacts. Its default evidence is the committed local
canonical set. CI passes the current host's generated evidence explicitly only
after the verifier has matched its source, wrapper, pinned host toolchain,
build settings, ABI contract, checksums, and SBOM. The app build always
reapplies API 36, Build Tools 36.1.0, NDK 29, and the ARM64/x86_64 debug-symbol
rules before invoking Tauri.

## 2026-07-20 artifact evidence

The local build completed for both requested ABIs:

| Artifact                   | ABI entry                              | SHA-256                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `Mish-arm64-v8a-debug.apk` | `lib/arm64-v8a/libmish_mobile.so` only | `ef6eae65c7cbbd841f9e4776ff4dc77acb9dd7bcda7de55896387c94c94d9ba9` |
| `Mish-x86_64-debug.apk`    | `lib/x86_64/libmish_mobile.so` only    | `2cc493cde54d57ed909e7a426b61395491b11685eb4f14bcd4b5aea83042b30e` |

Both APKs passed Android debug-signature verification and report application ID
`com.asuka109.mish`, version `0.1.0`, minimum SDK 28, and target SDK 36. The
application source Manifest requests only Internet access. The local plugin
Manifest owns the three bounded foreground/notification declarations and one
`VpnService` protected by `BIND_VPN_SERVICE`. The generated Android TV launcher,
FileProvider, and external-storage root path policy are absent. The project
checker rejects their return, permits only the bounded Core identity probe, and
continues to reject TUN ownership in the Phase 0 Kotlin source.

Archive entry and embedded-string checks found no desktop loopback bootstrap,
desktop WebView identifier, subscription, token, node, or user configuration.
`adb devices -l` returned no connected device, so installation, launch, offline
asset loading, activity recreation, and Meizu 20 Pro behavior remain manual
acceptance work.

## 2026-07-20 Mobile Core probe artifact

The first ARM64 package with the bounded JNI identity probe is available as
`Mish-android-arm64-core-probe-debug.apk`. It is 184,521,709 bytes and has
SHA-256
`9d757b76ea61e03d0fc85e153cd797922be2ffc696f69c709e2c959ebc2fa81b`.
Android debug signing verifies with APK Signature Scheme v2.

The APK contains exactly the ARM64 Tauri library, JNI probe, and verified Mobile
Core. The packaged Core SHA-256 is
`ef5db794bf29970d5f813d3147e27ada01ecd32aaed62b76779f6d1388386034`,
and its embedded bounded identity is Mihomo `v1.19.29`, commit
`e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`, wrapper
`mish-mobile-core-v1`. The package still uses `FixtureVpnBackend`, never creates
a TUN, and must not be reported as a device VPN. No Android device was connected
during this build.

## Meizu 20 Pro Android 16 manual acceptance

Use a Meizu 20 Pro running Android 16 with USB debugging enabled. Record the
device build fingerprint and attach timestamps or a short screen recording to
each result. This checklist validates only the lifecycle fixture, not packet
routing or Core readiness.

1. Build the ARM64 debug APK, verify its signature and ABI entry, install it with
   `adb install -r`, and launch `com.asuka109.mish/.MainActivity`. Confirm all Web
   assets load offline and the five labeled destinations remain above the
   gesture/navigation inset in portrait and landscape.
2. On Home, confirm the fixture disclosure says VPN capture is unavailable. A
   package built after verified staging must show the pinned Mihomo version;
   an unstaged package must report Core unavailable.
   Tap **Review VPN permission**. Deny once and verify the state remains
   permission-required, no foreground notification appears, and no service
   remains in `adb shell dumpsys activity services com.asuka109.mish`.
3. Retry and accept the system VPN dialog. Confirm returning to the Activity
   does not start a service, show a VPN key, create a network interface, or
   change traffic behavior.
4. On Android 13+, tap **Allow status notification**. Exercise both allow and
   deny on clean app-data runs. Denial must not crash; the UI must keep an honest
   fixture state and Android may expose foreground status only in Task Manager.
5. Tap **Run lifecycle check**. Confirm the low-importance notification text
   says `Lifecycle fixture only · no traffic capture`; the fixture reaches
   `unavailable`, keeps that honest notification visible, and never shows a
   connected VPN key. Tap **Stop lifecycle check** and confirm foreground state
   and the notification are removed.
6. During the check, rotate the device, background and foreground the app,
   reload/destroy the WebView through the developer setting, and run
   `adb shell am force-stop com.asuka109.mish` followed by relaunch. Confirm a
   complete snapshot is reconciled and no stale sequence overwrites it.
7. For process recovery, capture a debug snapshot in a transitional phase,
   terminate the application process without clearing data, and relaunch. The
   first authoritative snapshot must be `recovery-required`; it must not replay
   start. Use **Reset lifecycle state** and verify the result is stopped.
8. Revoke Mish under Android VPN settings while the fixture service is being
   exercised. Confirm `onRevoke` reaches permission-required, foreground state
   is removed, and the next check requires explicit system consent again.
9. Exercise gesture and three-button back from child routes. Confirm predictive
   back returns within React Router history before the system home transition,
   with no double-pop, frozen WebView, or custom edge gesture conflict.
10. Inspect `adb shell dumpsys package com.asuka109.mish`, the merged Manifest,
    `adb shell dumpsys notification`, and network interfaces. Confirm there is
    one protected `systemExempted` VPN service, no Leanback launcher or
    FileProvider, no TUN/interface owned by Mish, no desktop executable, and at
    most the expected ABI-specific `libmish_mobile_core.so` plus JNI probe.

Record failures as Phase 0 lifecycle defects. TCP, UDP, DNS, routing, socket
protection, network switching, 24-hour endurance, and VPN key persistence are
explicitly deferred until the verified Core/ABI backend replaces the fixture.

## CI policy

Pull requests run the bounded fast gate and upload no Android package. Only a
push to `main` runs the independent Android packaging job. That job installs the
pinned JDK, Android command-line tools, SDK, NDK, and Rust targets; restores
pnpm, Gradle, and Rust build caches; builds the pinned Mobile Core twice and
requires byte-identical output on that host; verifies and stages the first pass
against the generated evidence anchored to repository-owned source and
toolchain inputs; builds separate ARM64 and x86_64 debug APKs; verifies
signatures, ABI entries, JNI probes, and the exact packaged Core hashes against
that same evidence; publishes hashes and provenance in the job summary; and
uploads a 14-day, explicitly non-production test artifact. Local default
staging continues to use the committed canonical evidence rather than silently
trusting arbitrary generated checksums.
Complete repository and real-browser validation run as a daily or manually
dispatched inspection of the latest `main`.

If an automated merge credential does not emit a follow-up push workflow, run
the CI workflow manually on `main` with task `packages`. This recovery path
checks out the latest `main` and runs only the two package jobs; task
`inspection` remains the default for manual dispatch.
