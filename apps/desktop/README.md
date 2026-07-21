# Mish Desktop Shell

This package is the thin Tauri 2 shell for `@mish/web`. Development loads the
explicit Vite origin at `http://127.0.0.1:4173`; production embeds the offline
Web bundle. The native window keeps an 800×600 minimum and always retains the
desktop sidebar.

```sh
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:bundle:macos
```

## Ownership

The shell composes, but does not reimplement:

- an authenticated in-process desktop bridge on ephemeral loopback;
- process-only RPC bootstrap for the main WebView and one-time browser launch;
- native window, application menu, status bar, launch-at-login, material, and
  lifecycle behavior;
- the macOS System Proxy adapter and explicit development TUN service;
- offline assets, profile/runtime startup, and ordered shutdown.

Standalone Vite remains fixture-backed. The desktop process generates its own
256-bit token, keeps it out of URLs and storage, and gives it only to authorized
clients. Mihomo never starts merely because the Web UI opens. Development
requires explicit `MISH_MIHOMO_BIN`; production accepts only the packaged pinned
resource.

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
