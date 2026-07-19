# Android Phase 0 Prototype

## Scope and claim boundary

Phase 0 packages the standalone Mish mobile shell with a typed Tauri native
fixture. The shell has Home, Routes, Profiles, Activity, and Settings as its
five primary destinations. It does not reuse the desktop loopback bridge or a
desktop sidecar.

The fixture reports both the native Core and VPN capability as unavailable.
No Mihomo binary, VPN service, subscription, token, node, or user configuration
is included. This work proves the **compiled shell** evidence level and part of
the **native fixture** level defined by
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
pnpm android:check
```

Build one debug APK per ABI:

```sh
pnpm mobile:android:build
```

The build command always reapplies API 36, Build Tools 36.1.0, NDK 29, and the
ARM64/x86_64 debug-symbol rules before invoking Tauri.

## 2026-07-20 artifact evidence

The local build completed for both requested ABIs:

| Artifact                   | ABI entry                              | SHA-256                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `Mish-arm64-v8a-debug.apk` | `lib/arm64-v8a/libmish_mobile.so` only | `95659f23fa9184b270d408f3fd7a471f5cd6b3a0c0d56ff09e4a9b7a52d6cbeb` |
| `Mish-x86_64-debug.apk`    | `lib/x86_64/libmish_mobile.so` only    | `4fc9446707bb92ca2487bfcb6f1a1778fd5ef5a2753728cbb8dc021bdc74bf0c` |

Both APKs passed Android debug-signature verification and report application ID
`com.asuka109.mish`, version `0.1.0`, minimum SDK 28, and target SDK 36. The
source Manifest requests only Internet access and declares no VPN service. The
merged Manifest also contains AndroidX's application-scoped dynamic-receiver
permission.

Archive entry and embedded-string checks found no desktop loopback bootstrap,
desktop WebView identifier, subscription, token, node, or user configuration.
`adb devices -l` returned no connected device, so installation, launch, offline
asset loading, activity recreation, and Meizu 20 Pro behavior remain manual
acceptance work.

## CI policy

Pull requests run the bounded fast gate and upload no Android package. Only a
push to `main` runs the independent Android packaging job. That job installs the
pinned JDK, SDK, NDK, and Rust targets; restores pnpm, Gradle, and Rust build
caches; builds separate ARM64 and x86_64 debug APKs; verifies signatures and ABI
entries; publishes hashes and provenance in the job summary; and uploads a
14-day, explicitly non-production test artifact. Complete repository and
real-browser validation run as a daily or manually dispatched inspection of the
latest `main`.
