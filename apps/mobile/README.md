# Mish Mobile Shell

This package owns the Tauri 2 mobile application shell. Phase 0 packages a
typed native fixture and an Android `VpnService` lifecycle prototype. The
prototype requests VPN consent only after an explicit user action, exercises
foreground-service and recovery semantics, and publishes authoritative typed
snapshots. Its replaceable fixture backend never creates a TUN interface,
captures traffic, or starts Mihomo. A separately verified Mobile Core build may
be staged into generated `jniLibs`; the native probe then reports its bounded
ABI and version identity without claiming that VPN traffic capture is connected.

The Android project is generated from the committed Tauri configuration with:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"
pnpm mobile:android:init
```

See `docs/operations/android-phase0-prototype.md` for the exact toolchain and
artifact verification procedure.
