# Mish Workstation Bootstrap

This guide takes a clean clone to the shared development baseline. An Apple
Silicon Mac is required for macOS/iOS acceptance; Linux can cover Web, Rust, and
most Android work.

## Requirements

- Node.js 24 and pnpm 11.13.1;
- stable Rust with `rustfmt` and Clippy;
- Git and GitHub CLI;
- Xcode Command Line Tools for macOS builds;
- OpenJDK 17, Android SDK tools, and `adb` for Android work;
- `trash` for safe cleanup.

Full Android builds use API 36, Build Tools 36.1.0, command-line tools revision
14742923, NDK 29.0.14206865, and Rust targets `aarch64-linux-android` and
`x86_64-linux-android`. Full Xcode is needed only for iOS shell, extension,
signing, or simulator work. Allow at least 60 GiB free before installing both
mobile toolchains and producing clean multi-ABI builds.

One Homebrew-based macOS starting point is:

```sh
xcode-select --install
brew install gh fnm rustup openjdk@17 trash
export PATH="$(brew --prefix rustup)/bin:$PATH"
fnm install 24
fnm default 24
npm install --global pnpm@11.13.1
rustup default stable
rustup component add rustfmt clippy
```

Verify the active tools rather than assuming shell-profile changes applied:

```sh
node --version
pnpm --version
rustc --version
cargo --version
gh --version
java -version
```

## Clone and verify

```sh
mkdir -p "$HOME/repositories"
cd "$HOME/repositories"
git clone https://github.com/Asuka109/mish.git
cd mish
pnpm install --frozen-lockfile
pnpm check:pr
```

For the complete local inspection, install the pinned Chromium once and run:

```sh
pnpm test:browser:install
pnpm check:all
pnpm test:browser
```

Do not copy `.scratch`, `target`, application data, profiles, `.env` files,
keystores, or signing material from another machine. Rebuild disposable outputs
from repository-owned inputs.

## Optional platform setup

### macOS desktop

```sh
pnpm prepare:mihomo
export MISH_MIHOMO_BIN="<absolute-path-reported-by-prepare-mihomo>"
pnpm desktop:dev
```

See [macOS packaging](docs/operations/macos-packaging.md) before building or
installing an app bundle. System Proxy and TUN tests mutate host state and must
follow their acceptance and cleanup procedures.

### Android

Install the pinned SDK components with Android Studio or `sdkmanager`, then:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"
pnpm check:android
pnpm mobile:android:test
```

The generated Android project contains tracked inputs. Run
`pnpm mobile:android:init` only to intentionally regenerate a missing project,
then inspect every diff. Use the [Android Phase 0 guide](docs/operations/android-phase0-prototype.md)
for Core staging, APK builds, device checks, and evidence limits.

### Mobile Core and iOS

The [Mobile Core README](mobile-core/README.md) owns reproducible Android Core
build and staging commands. A staged Core proves identity, not VPN traffic.

iOS currently has contracts but no complete shell or Packet Tunnel build. Start
with [mobile runtime integration](docs/architecture/mobile-runtime-integration.md)
and [mobile validation](docs/quality/mobile-validation.md); do not invent signing
identifiers or claim device readiness.

## Completion

- the worktree contains only intentional files;
- tool versions match the pinned baseline;
- dependency installation and `pnpm check:pr` pass;
- any needed platform-specific static/plugin tests pass;
- native artifacts are checksum-matched before staging;
- no credential, private profile, or local secret entered the repository.

Continue with [`development.md`](development.md) for daily workflow and
[`docs/operations/development-commands.md`](docs/operations/development-commands.md)
for all commands.
