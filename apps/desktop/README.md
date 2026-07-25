# Mish Desktop Shell

This package is the thin Tauri 2 shell for `@mish/web`. Development selects the
first available IPv4-loopback port from 4173 and gives the same exact origin to
Vite, Tauri, and the local bridge allowlist. Production embeds the offline Web
bundle. The native window keeps an 800×600 minimum and always retains the
desktop sidebar.

```sh
pnpm desktop:demo
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:build:macos
```

`desktop:demo` is an explicit source-development target. It opens the shared
desktop UI with fictional fixture clients under the isolated
`com.asuka109.mish.demo` identifier. It does not require a Core binary or
initialize application data, the desktop bridge, runtime ownership, System
Proxy, TUN, the status bar, or login-launch integration. Multiple worktrees may
run desktop demos concurrently.

## Process-local WebView Inspector

The desktop WebView Inspector is disabled by default in development and
packaged builds. Enable it for one development process with either supported
startup input:

```sh
pnpm prepare:mihomo
MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29" \
  pnpm desktop:dev -- --devtools

MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29" \
  MISH_DEVTOOLS=1 pnpm desktop:dev
```

The command-line flag takes precedence over `MISH_DEVTOOLS`. Without the flag,
the environment value must be exactly `1` (enabled) or `0` (disabled). Any
other value fails startup with the Inspector disabled. The option exists only
in the current process and is never copied into Settings, application storage,
or a later launch.

On supported macOS builds, the opt-in opens WebKit's local Inspector for Mish's
main desktop WebView. It does not expose the standalone Browser Client, start a
remote-debugging endpoint, or change the authenticated bridge, CSP, or RPC
authorization.

> **Sensitive diagnostic warning:** The Inspector can reveal local application
> state, tokens, authenticated bridge payloads, Profile-derived data, network
> activity, and other sensitive diagnostics. Do not share screenshots, exports,
> or copied values without reviewing and redacting them.

## Ownership

The shell composes, but does not reimplement:

- an authenticated in-process desktop bridge on ephemeral loopback;
- process-only RPC bootstrap for the main WebView and one-time browser launch;
- native window, application menu, status bar, launch-at-login, material, and
  lifecycle behavior;
- the macOS System Proxy adapter and explicit development TUN service;
- offline assets, profile/runtime startup, and ordered shutdown.

Outside the explicit demo commands, browser startup requires either PIN pairing
or a valid process-local browser session; it never falls through to demo state.
The operational desktop process generates its own 256-bit token, keeps it out
of URLs and storage, and gives it only to authorized clients. Mihomo never
starts merely because the Web UI opens. Operational development requires
explicit `MISH_MIHOMO_BIN`; production accepts only the packaged pinned
resource. When `MISH_MIHOMO_BIN` is missing, desktop setup fails immediately
with the preparation and restart commands instead of opening an unusable window.

System Proxy defaults off and is journaled, confirmed, and restored by the
shared runtime. Source development may install the bounded root LaunchDaemon
described in the TUN contract. Ad-hoc app packages contain no production helper
and therefore keep packaged TUN unavailable.

## Authoritative details

- [Bootstrap and local-origin threat model](../../docs/architecture/desktop-bootstrap.md)
- [Frontend/platform ownership](../../docs/architecture/frontend-platform-boundary.md)
- [Settings](../../docs/architecture/settings-contracts.md)
- [Status bar and window lifecycle](../../docs/architecture/native-status-bar-lifecycle.md)
- [macOS TUN helper](../../docs/architecture/macos-tun-helper.md)
- [Packaging and signing](../../docs/operations/macos-packaging.md)
- [Native sidebar validation](../../docs/quality/native-sidebar-validation.md)
