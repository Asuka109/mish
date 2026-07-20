# Mish Workstation Bootstrap

This guide brings a new workstation from a clean clone to a verified Mish
development environment. It targets an Apple Silicon Mac because that is the
only host that can cover the current macOS package and future iOS work. Linux
can still support Web, Rust, and most Android work, but it cannot replace the
macOS and iOS acceptance gates.

For daily workflow, task isolation, and validation rules, continue with
[`development.md`](development.md). Product and architecture authority remains
in [`PRODUCT.md`](PRODUCT.md), [`DESIGN.md`](DESIGN.md), and
[`docs/README.md`](docs/README.md).

## 1. Capacity and host assumptions

Recommended handoff workstation:

- Apple Silicon Mac with a current supported macOS release;
- at least 16 GiB RAM, with 32 GiB or more preferred for Android and Xcode;
- at least 60 GiB free before installing the full Android and Apple toolchains;
- Xcode Command Line Tools for ordinary macOS builds;
- full Xcode only when starting iOS shell, extension, signing, or simulator work;
- one physical Android ARM64 device for the device-VPN milestone.

The pinned Android SDK, JDK, NDK, and Rust targets occupy several GiB. A
reproducible dual-ABI Mobile Core build uses about 3.3 GiB of task-owned scratch
space according to
[`mobile-core/evidence/android-v1.19.29/disk-usage.md`](mobile-core/evidence/android-v1.19.29/disk-usage.md).
Rust, Gradle, Web, Xcode, and emulator intermediates are additional. Keep build
outputs disposable and do not place the repository on a nearly full system
volume.

## 2. Install host tools

Install Xcode Command Line Tools:

```sh
xcode-select --install
```

Install or otherwise provide these commands:

- `git` and `gh`;
- Node.js 24;
- pnpm 11.13.1;
- `rustup`, stable Rust, `rustfmt`, and Clippy;
- OpenJDK 17;
- Android command-line tools, `sdkmanager`, and `adb`;
- `trash`, used instead of permanent shell deletion.

One Homebrew-based starting point is:

```sh
brew install gh fnm rustup openjdk@17 trash
export PATH="$(brew --prefix rustup)/bin:$PATH"
fnm install 24
fnm default 24
npm install --global pnpm@11.13.1
rustup default stable
rustup component add rustfmt clippy
```

Persist the Rustup `PATH` export in the shell profile, open a new shell, then
verify the active versions:

```sh
node --version
pnpm --version
rustc --version
cargo --version
gh --version
java -version
```

Expected project baselines are Node 24, pnpm 11.13.1, stable Rust, and Java 17.
Authenticate GitHub CLI before preparing the desktop Mihomo resource:

```sh
gh auth login
gh auth status
```

## 3. Clone into the standard workspace

```sh
mkdir -p "$HOME/repositories"
cd "$HOME/repositories"
git clone https://github.com/Asuka109/mish.git
cd mish
git status --short
git log --oneline -5
pnpm install --frozen-lockfile
```

Do not copy `.scratch/`, `target/`, application data, subscription files,
keystores, signing material, or `.env` files from another machine. Rebuild
disposable artifacts from pinned repository inputs.

## 4. Verify the shared development baseline

The pull-request-equivalent gate is the first check on a new clone:

```sh
pnpm validate:pr
```

Then install the repository-owned Playwright browser and run the complete local
inspection when time permits:

```sh
pnpm test:browser:install
pnpm validate
pnpm test:browser
```

`validate:pr` is the fast static, TypeScript, contract, formatting, token, and
documentation gate used by pull requests. `validate` additionally compiles and
tests the Rust workspace, builds the Web app, runs Clippy, and checks the design
contract. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the
authoritative CI split.

## 5. Run the Web and macOS clients

Run the browser fixture:

```sh
pnpm dev
```

It listens on `http://127.0.0.1:4173` and deliberately does not start a native
Core or desktop RPC service.

Prepare the pinned Mihomo v1.19.29 Apple Silicon binary, then run the Tauri
desktop shell with an explicit development Core:

```sh
pnpm mihomo:prepare
export MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"
pnpm desktop:dev
```

Create and verify an ad-hoc Apple Silicon test bundle with:

```sh
pnpm desktop:bundle:macos
```

No Developer ID secrets are required for local prototype work. Follow
[`docs/operations/macos-packaging.md`](docs/operations/macos-packaging.md) for
package verification, Gatekeeper handling, signing, notarization, installation,
and cleanup. Never disable Gatekeeper globally.

## 6. Install the pinned Android toolchain

Use Android Studio's SDK Manager or `sdkmanager` to install exactly:

- command-line tools revision 14742923;
- `platforms;android-36`;
- `build-tools;36.1.0`;
- `platform-tools`;
- `ndk;29.0.14206865`.

Then add only the currently supported Android Rust targets:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
```

For a Homebrew JDK and the default macOS Android SDK location, add the following
non-secret configuration to the shell profile:

```sh
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"
```

Open a new shell and verify:

```sh
java -version
adb version
sdkmanager --list_installed
rustup target list --installed
pnpm android:check
pnpm mobile:android:test
```

The generated Android project is already versioned where the project requires
stable generated input. Run `pnpm mobile:android:init` only when intentionally
regenerating a missing project, then inspect every generated diff before keeping
it.

## 7. Build and stage the Mobile Core

No system Go installation is required. The build script downloads and verifies
the pinned official Go 1.26.0 toolchain under ignored scratch storage.

```sh
pnpm mobile-core:contract
pnpm mobile-core:build
pnpm mobile-core:verify
pnpm mobile-core:stage:android
pnpm mobile:android:build
```

The Mobile Core build checks the Mihomo tag, commit, tree, toolchains, exported
ABI symbols, dual-build reproducibility, checksums, provenance, and SBOM. The
staging command accepts only checksum-matched ELF artifacts and copies them into
ignored generated `jniLibs` directories. Never commit `.so` files.

Current mobile builds may prove packaged Core identity while the production
`VpnService` still uses a truthful fixture backend. Packaged identity is not
evidence that traffic traverses a device VPN. The evidence levels are defined in
[`docs/quality/mobile-validation.md`](docs/quality/mobile-validation.md).

## 8. Connect the Android test device

Enable developer options and USB debugging on the test device, then confirm the
host sees exactly the intended device:

```sh
adb devices -l
```

Build the ARM64 debug package, locate the resulting APK, and install it only
after checking its source revision and signature:

```sh
pnpm mobile:android:build
find apps/mobile/src-tauri/gen/android/app/build/outputs/apk -name '*arm64*-debug.apk' -print
adb install -r /absolute/path/to/the-arm64-debug.apk
```

Do not claim a device VPN until permission, TCP, UDP, DNS, routing, socket
protection, lifecycle, recovery, and safe stop have been observed on the device.
Use the acceptance matrix in
[`docs/operations/android-phase0-prototype.md`](docs/operations/android-phase0-prototype.md)
and [`docs/quality/mobile-validation.md`](docs/quality/mobile-validation.md).

## 9. iOS preparation boundary

Install full Xcode before beginning iOS work. At the time of this guide, the
repository defines the iOS architecture and validation contract but does not
yet contain a complete generated iOS shell, Packet Tunnel extension, or pinned
XCFramework build flow. Do not invent signing identifiers or claim device VPN
readiness. Start from
[`docs/architecture/mobile-runtime-integration.md`](docs/architecture/mobile-runtime-integration.md)
and complete the compile-only gates in
[`docs/quality/mobile-validation.md`](docs/quality/mobile-validation.md) before
requesting Apple capabilities.

## 10. Secrets and private data

- Never commit or log subscription URLs, profile contents, proxy credentials,
  private paths, bridge tokens, keystores, certificates, or signing keys.
- `MISH_BRIDGE_TOKEN` and `MISH_MOCK_TOKEN` are ephemeral development values,
  not persisted configuration.
- `MISH_MIHOMO_BIN`, `MIHOMO_BIN`, `JAVA_HOME`, `ANDROID_HOME`, and NDK paths are
  local machine configuration and may be stored without their private data.
- Apple signing secrets belong in the credential-gated GitHub Actions path
  described by the packaging documentation.
- Real subscription input belongs only in the application UI during manual
  acceptance.

## 11. Reclaim disposable disk space

Stop builds before cleanup. Use `trash`, never permanent recursive deletion:

```sh
trash target
trash .scratch/mobile-core
trash apps/mobile/src-tauri/gen/android/.gradle
trash apps/mobile/src-tauri/gen/android/build
trash apps/mobile/src-tauri/plugins/mish-vpn/android/build
```

Do not trash tracked generated Android inputs. Check first with:

```sh
git status --short
git ls-files apps/mobile/src-tauri/gen/android
```

## Bootstrap completion checklist

- `git status --short` contains only intentional work;
- Node, pnpm, Rust, and Java match the project baselines;
- `pnpm install --frozen-lockfile` succeeds;
- `pnpm validate:pr` succeeds;
- the browser fixture starts;
- the macOS shell starts with an explicit pinned Core;
- Android static checks and plugin tests succeed;
- Mobile Core build evidence verifies before staging;
- `adb devices -l` sees the intended device when device work begins;
- no credentials or private profile data appear in the repository.
