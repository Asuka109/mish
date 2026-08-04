# Mish Mobile Shell

This package owns the Tauri 2 mobile application shell. Installed Android wraps
the one Tauri WebView in Material app-bar and bottom-navigation Views. Native
chrome enters through the Shared Rust shell authority and delivers one-way Web
entries; product pages, internal history/Back/focus, and business sheets remain
in React. Set Gradle property `mishNativeShell=false` to compile the retained
Web-shell fallback.

Phase 0 also packages a typed native fixture and an Android `VpnService` lifecycle prototype. The
prototype requests VPN consent only after an explicit user action, exercises
foreground-service and recovery semantics, and publishes authoritative typed
snapshots. Its replaceable fixture backend never creates a TUN interface,
captures traffic, or starts Mihomo. A separately verified Mobile Core build may
be staged into generated `jniLibs`; the native probe then reports its bounded
ABI and version identity without claiming that VPN traffic capture is connected.
The bounded configuration slice validates and loads only repository-owned
fictional bytes, publishes revision/digest state with rollback or explicit
unknown recovery, and still cannot start Core, create a TUN, or capture traffic.

The generated Android project contains tracked inputs. Configure and test the
existing project with:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"
pnpm mobile:android:configure
pnpm mobile:android:test
```

Run `pnpm mobile:android:init` only when intentionally regenerating a missing
project, then inspect every diff. See the
[Android Phase 0 guide](../../docs/operations/android-phase0-prototype.md) for
the exact toolchain, Core staging, and artifact verification procedure.
