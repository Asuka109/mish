# Mish Mobile Shell

This package owns the Tauri 2 mobile application shell. Phase 0 packages a
typed native fixture and an Android `VpnService` lifecycle prototype. The
prototype requests VPN consent only after an explicit user action, exercises
foreground-service and recovery semantics, and publishes authoritative typed
snapshots. Its replaceable fixture backend never creates a TUN interface,
captures traffic, or starts Mihomo. A separately verified Mobile Core build may
be staged into generated `jniLibs`; staging also generates the ignored bounded
admission manifest, and the native probe admits the exact source, wrapper, ABI,
digest, signature scheme, and build-owned signer fingerprint before JNI
validation, load, or Core effects. Rejection remains observable without exposing paths, certificate
bytes, or native text; the native probe then reports its bounded ABI and
version identity without claiming that VPN traffic capture is connected.
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

Configuration also restores the reviewed Gradle distribution URL and SHA-256
pin before any checked-in wrapper execution. `pnpm check:android` rejects
wrapper URL, version, checksum, or duplicate-property drift.

Debug APKs use the repository-owned `mishFixtureDebug` JKS and its paired public
certificate fixture. This credential-free signer is only for deterministic
debug/test admission evidence; the release build type does not reference it,
and it must never be treated as a release or store signing identity. CI reads
the certificate SHA-256 from each actual APK and compares it with the pinned
`mobile-core/source-manifest.json` value before upload.

Run `pnpm mobile:android:init` only when intentionally regenerating a missing
project, then inspect every diff. See the
[Android Phase 0 guide](../../docs/operations/android-phase0-prototype.md) for
the exact toolchain, Core staging, and artifact verification procedure.
