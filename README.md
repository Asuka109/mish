# Mish

![Mish wordmark](packages/brand-assets/public/brand/mish-brand.svg)

Mish is an independent, experimental desktop and mobile client for a locally
managed [Mihomo](https://github.com/MetaCubeX/mihomo) Core. It combines a shared
React and TypeScript interface with Tauri and Rust platform services. Mish is
licensed under GPL-3.0-only and is not affiliated with, endorsed by, or an
official client of MetaCubeX.

> [!IMPORTANT]
> Mish does not have a stable public release. Current macOS and Android
> artifacts are short-lived test packages for development and verification,
> not production distributions. Public distribution remains gated by the
> active packaging audit, signing and notarization evidence, platform
> acceptance, and third-party license review. See the
> [public-release review](docs/legal/public-release-review.md).

Mish is client software only. The project does not operate a hosted proxy or
VPN service, sell subscriptions, provide network endpoints, or guarantee that
any user-supplied configuration or remote service will work.

## Current capabilities

- Import, validate, store, edit, and activate local or HTTPS Mihomo profiles.
- Observe Status, Routes, Traffic, Events, Diagnostics, settings, and managed
  runtime state through typed application contracts.
- Change routing mode and policy-group selections through the pinned Mihomo
  Controller API.
- Apply and reconcile macOS System Proxy state through an authenticated local
  bridge, with explicit recovery and safe-stop paths.
- Run a source-development macOS TUN service behind separate installation and
  authorization gates.
- Exercise an offline browser demo with fictional data and no native effects.
- Build an Android lifecycle prototype that requests system VPN consent and
  probes the identity of a source-built Mobile Core without capturing traffic.

## Platform status

| Target        | Evidence-backed status                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser       | Six-route offline demo backed by explicit fixtures. It does not connect to desktop RPC, start Mihomo, or change network settings.                                                                                                                                                                                    |
| macOS         | Apple Silicon development and test-package path with an authenticated in-process bridge, managed Mihomo lifecycle, reversible System Proxy, native window and status-bar integration, and a separately installed development TUN service. The test package is ad-hoc signed unless release credentials are supplied. |
| Android       | Installable Tauri shell, `VpnService` lifecycle prototype, and verified Mobile Core identity probe. It does not yet establish a TUN interface or capture traffic.                                                                                                                                                    |
| iOS           | Architecture and validation contracts only. There is no complete shell, Packet Tunnel extension, signed-device path, or XCFramework packaging flow.                                                                                                                                                                  |
| Windows/Linux | No supported package or completed native integration in this repository.                                                                                                                                                                                                                                             |

The desktop Core is pinned to Mihomo `v1.19.29`. Exact implementation claims
are maintained in the
[production Web](docs/quality/production-web-validation.md),
[macOS](docs/quality/macos-p0-acceptance.md), and
[mobile](docs/quality/mobile-validation.md) validation documents.

## Downloads and installation

There is no recommended end-user download yet. GitHub Actions is configured to
produce expiring test artifacts from `main`; a successful run, artifact identity,
and digest must be verified before testing. The credential-free macOS path is
ad-hoc signed and not notarized, and the Android path produces a debug prototype.
Do not mirror or present either artifact as a stable release.

Maintainers and testers should follow the bounded
[macOS packaging](docs/operations/macos-packaging.md) or
[Android Phase 0](docs/operations/android-phase0-prototype.md) instructions.
Those documents describe the exact artifact identity, verification, and cleanup
steps.

## Development quick start

Requirements:

- Node.js 24;
- pnpm 11.13.1; and
- the stable Rust toolchain.

Install dependencies and run the pull-request gate:

```sh
pnpm install --frozen-lockfile
pnpm check:pr
```

Run the fictional browser demo:

```sh
pnpm demo
```

`pnpm demo` serves the explicit fixture on `http://127.0.0.1:4173` when that
port is available and otherwise uses the next available port. It does not
authenticate, read application data, start Mihomo, or modify host network
settings.

For Apple Silicon macOS desktop development:

```sh
pnpm prepare:mihomo
export MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"
pnpm desktop:dev
```

The preparation command downloads the pinned upstream release with GitHub CLI,
stores it in ignored scratch space, and verifies its published digest. The
desktop process creates its own ephemeral bridge credential; do not configure
or persist one.

Use [`bootstrap.md`](bootstrap.md) for first-time workstation setup and the
[development command registry](docs/operations/development-commands.md) for the
complete command set.

## Architecture

```text
React/TypeScript UI
        |
        v
typed contracts and authenticated local RPC
        |
        v
Rust application runtime and desktop bridge
        |
        +--> platform-owned System Proxy / TUN boundaries
        |
        +--> managed, pinned Mihomo Core and Controller API
```

| Path                                                   | Responsibility                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [`apps/web`](apps/web)                                 | Shared interface and browser, desktop, and mobile client selection               |
| [`apps/desktop`](apps/desktop)                         | Thin Tauri desktop shell and native composition                                  |
| [`apps/mobile`](apps/mobile)                           | Tauri mobile shell and Android lifecycle plugin                                  |
| [`crates/runtime`](crates/runtime)                     | Transport-neutral application state and commands                                 |
| [`crates/desktop-bridge`](crates/desktop-bridge)       | Authenticated RPC, process lifecycle, profiles, persistence, and desktop effects |
| [`crates/mihomo-controller`](crates/mihomo-controller) | Bounded adapter for the pinned Mihomo Controller API                             |
| [`crates/profile`](crates/profile)                     | Profile validation, persistence, patches, and activation inputs                  |
| [`mobile-core`](mobile-core)                           | Pinned native Core ABI, reproducible build inputs, and evidence                  |
| [`packages`](packages)                                 | Shared contracts, RPC client, fixtures, UI, tokens, and brand assets             |

The WebView never owns a TUN descriptor, VPN lifetime, privileged state, or
Mihomo process. Browser fixtures never claim native or network success.

## Security and privacy

Mish is local-first, not network-isolated. The desktop bridge binds to loopback
and requires an application-created credential, while profiles, Mihomo,
scheduled provider operations, delay tests, service probes, and remote service
icons can make outbound requests. There is no configured telemetry, hosted
account service, crash reporter, or automatic updater in the current
repository.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability and
[PRIVACY.md](PRIVACY.md) for current storage, network, export, and deletion
behavior. Never include real profiles, subscription addresses, credentials,
node labels, bridge credentials, or unredacted support bundles in public issues,
screenshots, CI logs, or documentation.

## Limitations and roadmap boundaries

- Mish is pre-release software and may contain defects that affect connectivity,
  system proxy settings, local files, or user expectations.
- Public macOS release claims require Developer ID signing, notarization,
  packaged privileged-helper verification, installed-app acceptance, and
  reconciliation with the active packaging audit.
- Android and iOS require real native VPN data paths, socket protection,
  lifecycle recovery, signed-device validation, and distribution-policy review.
- Windows and Linux support are not scheduled commitments.
- An updater, hosted service, paid support, compatibility guarantee, service
  availability guarantee, and release date are outside the current scope.
- Distribution must not proceed until the open dependency-license and legal
  notice questions in the
  [public-release review](docs/legal/public-release-review.md) are resolved.

Roadmap documents describe intent, not promises. Code, tests, package manifests,
and target-specific validation evidence remain the authority for current
behavior.

## Documentation and contributing

Start with the [documentation index](docs/README.md). The principal contracts
are:

- [`PRODUCT.md`](PRODUCT.md) for product behavior and claim boundaries;
- [`DESIGN.md`](DESIGN.md) for visual tokens and interaction rules;
- [`development.md`](development.md) for repository workflow and validation;
- [`docs/architecture`](docs/architecture) for runtime and platform boundaries;
  and
- [`docs/quality`](docs/quality) for evidence and acceptance gates.

Contributions are welcome within the current experimental scope. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License and attribution

Mish-authored source is licensed under
[GPL-3.0-only](LICENSE). Third-party components and assets retain their own
licenses and notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The repository's public-release materials are engineering documentation, not
legal advice. See [DISCLAIMER.md](DISCLAIMER.md).
