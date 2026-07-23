# Mish

[English](README.md) | [简体中文](README.zh-CN.md)

![Mish wordmark](packages/brand-assets/public/brand/mish-brand.svg)

**Mish is a cross-platform client for local traffic forwarding, configuration,
and diagnostics.**

> [!IMPORTANT]
> Mish does not have a stable public release. The completed packaging-readiness
> audit selected a System Proxy-only first public macOS release, but release
> preparation and acceptance are not complete. See the
> [macOS packaging status](docs/operations/macos-packaging.md).

## What Mish does

- Imports and manages user-provided Mihomo profiles.
- Shows connection status, routing activity, traffic, events, and diagnostics.
- Lets users change routing modes and policy-group selections.
- Applies and safely restores the macOS System Proxy setting.
- Keeps local application data and provides user-initiated export and backup
  tools.

## Platform compatibility

| Platform              | Current compatibility      |
| --------------------- | -------------------------- |
| macOS (Apple Silicon) | 🚧 Limited compatibility   |
| Android               | ❌ Not currently supported |
| iOS                   | — Not currently available  |
| Windows               | — Not currently available  |
| Linux                 | — Not currently available  |

Notes:

- **macOS:** The current preview targets macOS 13 or later on Apple Silicon
  only. System Proxy is the selected path for the first public release. There
  is no stable package download yet.
- **Android:** A development prototype exists, but it is not a usable network
  client and is not supported for general use.
- **iOS:** Only early architecture and validation work exists.
- **Windows and Linux:** No usable application package or completed native
  integration exists.
- **Browser:** The repository includes a fictional offline demo for development
  and interface review; it is not a network client.

## Security and privacy

Mish is a neutral, experimental project built around a locally managed
[Mihomo](https://github.com/MetaCubeX/mihomo) Core. Its interface is built with
React and TypeScript, with Tauri and Rust providing platform integration. Mish
is not affiliated with, endorsed by, or an official client of MetaCubeX.

Mish is client software only. The project does not operate a hosted proxy or
VPN service, sell subscriptions, or provide network endpoints.

Use Mish only for lawful, authorized purposes and comply with the laws and
third-party terms that apply in your location. If you believe Mish or any
material in this repository infringes your rights, contact the project
maintainers. Do not include sensitive or personal information in a public
report.

Mish is local-first, not network-isolated. User profiles, Mihomo, provider
updates, delay tests, service probes, and remote service icons can make outbound
requests. The current repository does not configure telemetry, a hosted account
service, a crash reporter, or an automatic updater.

If you need to report a security or privacy concern, contact the project
maintainers without posting sensitive details publicly. Never post real
profiles, subscription addresses, credentials, node labels, bridge credentials,
or unredacted support bundles in public issues, screenshots, CI logs, or
documentation.

## Current limitations

- Mish is pre-release software and may contain defects that affect connectivity,
  system proxy settings, local files, or user expectations.
- The first public macOS release is planned as System Proxy-only. Virtual
  Interface support belongs to a separate future release path and is not
  currently available.
- Android, iOS, Windows, and Linux are not currently supported end-user
  platforms.
- Release packaging, signing, independent verification, installed-app
  acceptance, support policy, privacy decisions, supply-chain evidence, and
  complete dependency notices remain under review.
- Public distribution requires completion of the release work in the
  [macOS packaging guide](docs/operations/macos-packaging.md) and resolution of
  the dependency questions in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Roadmap documents describe intent, not promises. Code, tests, package manifests,
and target-specific validation evidence remain the authority for current
behavior.

## Development and contributing

Developer setup, commands, architecture, and validation details are maintained
in [`development.md`](development.md) and the
[documentation index](docs/README.md). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License and attribution

Mish-authored source is licensed under
[GPL-3.0-only](LICENSE). Third-party components and assets retain their own
licenses and notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
