# Mish

Mish is an independent GPL-3.0 proxy client powered by the Mihomo core. The
shared React/TypeScript product runs as an offline browser fixture, in a Tauri 2
macOS shell, and in an Android prototype. Mish is not affiliated with MetaCubeX.

## What works today

| Target  | Observed state                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser | Six-route product UI backed by an explicit fixture; it opens no desktop RPC connection.                                                                                                                |
| macOS   | Authenticated in-process bridge, managed Mihomo lifecycle, Profiles, Status, Routes, Traffic, Events, Settings, reversible System Proxy, native window/status bar, and source-development TUN service. |
| Android | Installable Tauri shell, `VpnService` lifecycle prototype, and verified Mobile Core identity probe. The production backend still does not create a TUN or capture traffic.                             |
| iOS     | Architecture and validation contracts only; no complete shell, Packet Tunnel extension, or XCFramework flow.                                                                                           |

The desktop Core is pinned to Mihomo `v1.19.29`. Packaged TUN, Developer ID
signing, notarization, and a real mobile VPN remain separate release gates. See
[production Web validation](docs/quality/production-web-validation.md),
[macOS P0 acceptance](docs/quality/macos-p0-acceptance.md), and
[mobile validation](docs/quality/mobile-validation.md) for exact claim levels.

## Quick start

Requirements: Node.js 24, pnpm 11.13.1, and stable Rust.

```sh
pnpm install --frozen-lockfile
pnpm check:pr
pnpm demo
```

`pnpm demo` serves the explicit browser demo on `http://127.0.0.1:4173` when
available and otherwise uses the next available port. It does not authenticate,
read application data, start Mihomo, or change system network settings.

Use `pnpm desktop:demo` for the same fictional data in a native Tauri desktop
window. It can run beside an operational desktop instance because it does not
initialize the bridge, managed-runtime lease, Core, System Proxy, or TUN.

For desktop development:

```sh
pnpm prepare:mihomo
export MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"
pnpm desktop:dev
```

The preparation command downloads the pinned official release into ignored
scratch storage and verifies its digest. The desktop process creates its own
ephemeral bridge token; do not configure or persist one.

Use [`bootstrap.md`](bootstrap.md) for a new workstation and
[`docs/operations/development-commands.md`](docs/operations/development-commands.md)
for the complete command registry.

## Repository map

| Path                                                   | Ownership                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| [`apps/web`](apps/web)                                 | Shared product UI and browser/desktop/mobile client selection   |
| [`apps/desktop`](apps/desktop)                         | Thin Tauri desktop shell and native composition                 |
| [`apps/mobile`](apps/mobile)                           | Tauri mobile shell and Android plugin                           |
| [`crates/runtime`](crates/runtime)                     | Transport-neutral application runtime contracts                 |
| [`crates/desktop-bridge`](crates/desktop-bridge)       | Authenticated RPC, lifecycle, profiles, and desktop effects     |
| [`crates/mihomo-controller`](crates/mihomo-controller) | Bounded Mihomo Controller adapter                               |
| [`crates/profile`](crates/profile)                     | Profile validation, persistence, patches, and activation inputs |
| [`mobile-core`](mobile-core)                           | Pinned native Core ABI, build, and evidence                     |
| [`packages`](packages)                                 | Contracts, RPC client, fixtures, UI, tokens, and brand assets   |
| [`sketch`](sketch)                                     | Retained interaction reference; never runtime evidence          |

## Non-negotiable boundaries

- Browser fixtures never claim native or network success.
- The WebView never owns a TUN descriptor, VPN lifetime, or privileged state.
- Native changes are confirmed and reversible; unsupported capabilities stay
  visibly unavailable.
- Real profiles, subscription URLs, credentials, bridge tokens, and raw
  Controller payloads never enter source, logs, screenshots, CI, or docs.
- Runtime assets ship locally. Network access is limited to user configuration,
  explicit probes, and explicitly initiated preparation/update paths.

## Documentation

Start at the [task-oriented documentation index](docs/README.md), then load only
the contract relevant to the change. The main authorities are:

- [`PRODUCT.md`](PRODUCT.md) — users, product behavior, and claim boundaries;
- [`DESIGN.md`](DESIGN.md) — visual tokens and styling rules;
- [`development.md`](development.md) — repository workflow and validation;
- [`docs/architecture`](docs/architecture) — runtime and platform contracts;
- [`docs/quality`](docs/quality) — evidence and acceptance gates.

The Chinese [development plan](.claude/plans/development-plan.md) is a compact
historical direction record, not the current implementation backlog.

## License

Mish is licensed under [GPL-3.0-only](LICENSE). Pinned upstream source and
attribution are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
