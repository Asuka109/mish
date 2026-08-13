# Mish Desktop Shell

This package is the thin Tauri 2 shell for `@mish/web`. Development selects the
first available IPv4-loopback port from 4173 and gives the same exact origin to
Vite, Tauri, and the local bridge allowlist. Production embeds the offline Web
bundle. The native window keeps an 800×600 minimum and always retains the
desktop sidebar.

```sh
pnpm desktop:demo
pnpm desktop:dev
pnpm desktop:dev:tart-tun
pnpm desktop:build
pnpm desktop:build:macos
```

`desktop:demo` is an explicit source-development target. It opens the shared
desktop UI with fictional fixture clients under the isolated
`com.asuka109.mish.demo` identifier. It does not require a Core binary or
initialize application data, the desktop bridge, runtime ownership, System
Proxy, TUN, the status bar, or login-launch integration. Multiple worktrees may
run desktop demos concurrently.

## Backend-first development

`pnpm desktop:dev` starts the operational Rust process, managed runtime,
Desktop Bridge/RPC, Browser Client, development Core preparation, native menu,
and status bar without creating the main WebView. Readiness prints exactly one
current Browser Client URL and one development-only desktop-window trigger URL:

```text
Mish Browser Client URL: http://127.0.0.1:<port>/#token=<capability>
Mish Desktop Window Trigger URL: http://127.0.0.1:<port>/__openWindow#token=<capability>
```

The printed Browser Client URL can authenticate multiple clean browser contexts
for the lifetime of this development process. A replacement process prints a
new URL and invalidates the prior capability. This development behavior does
not change the short-lived one-time URL issued by the production status bar.

Open the Browser Client for the primary no-window development surface. Open the
desktop-window trigger when the native WebView is needed. A current trigger
creates, reveals, or focuses the single `main` window. Closing that development
window hides it without stopping the backend, and a fresh request from the same
current trigger can reveal it again. Native status-bar, application-menu, and
Dock reopen actions use the same single-window controller. A hot rebuild starts
the replacement process without a window and prints new process-scoped links;
old links fail.

Use `pnpm desktop:dev -- --open` to ask the host's standard URL opener to open
the Browser Client after readiness. This option is off by default. Opener
failure is reported without stopping the backend, and both URLs are still
printed.

The trigger endpoint is compiled only into the source-development feature set.
It binds no additional listener and accepts only exact IPv4-loopback Host and
same-origin requests. Its 256-bit fragment capability never enters the initial
HTTP request, and each activation carries a fresh bounded request ID.
The current capability remains valid until its development process is replaced
or shuts down. Request IDs cannot be replayed, and a restarted process has
unrelated authority. Browser Client pairing, PIN, and one-time launch-token
expiry are separate and unchanged. The trigger does not contain or authenticate
the RPC token.

## Process-local WebView Inspector

The desktop WebView Inspector remains default-off in the application binary.
The tracked `.env.development` deliberately sets `MISH_DEVTOOLS=1` for
`desktop:dev` and `desktop:demo`. `desktop:demo` opens WebKit Inspector with its
normal demo window. Backend-first `desktop:dev` creates neither a WebView nor an
Inspector at startup; the Inspector opens only after the desktop-window trigger
creates the WebView:

```sh
pnpm desktop:dev
```

An existing process environment takes precedence over the tracked development
file. Disable the Inspector for one development process with:

```sh
MISH_DEVTOOLS=0 pnpm desktop:dev
```

The application still accepts explicit `--devtools` and `MISH_DEVTOOLS=1`
startup inputs outside that convenience workflow. The command-line flag takes
precedence over `MISH_DEVTOOLS`. Without the flag, the environment value must be
exactly `1` (enabled) or `0` (disabled). Any other value fails startup with the
Inspector disabled. The option exists only in the current process and is never
copied into Settings, application storage, or a later launch.

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
- process-only RPC bootstrap for the main WebView, one-time production browser
  launch, and current-process reusable development launch;
- native window, application menu, status bar, launch-at-login, material, and
  lifecycle behavior;
- the macOS System Proxy adapter and explicit development TUN service;
- offline assets, profile/runtime startup, and ordered shutdown.

Outside the explicit demo commands, browser startup requires either PIN pairing
or a valid process-local browser session; it never falls through to demo state.
The operational desktop process generates its own 256-bit token, keeps it out
of URLs and storage, and gives it only to authorized clients. Mihomo never
starts merely because the Web UI opens. When `MISH_MIHOMO_BIN` is unset, the
tracked launcher prepares the repository pin and verifies its manifest,
archive and binary digests, version, regular-file type, and mode `0755`. An
explicit `MISH_MIHOMO_BIN` remains the local Core debugging override: it must
be an absolute regular executable with mode `0755` and report the required
macOS arm64 version. A missing or invalid explicit override fails early without
falling back to the repository pin. Tauri revalidates the source-appropriate
file contract before setup. Production accepts only the packaged pinned
resource, and no application runtime downloads an executable.

System Proxy defaults off and is journaled, confirmed, and restored by the
shared runtime. Source development may install the bounded root LaunchDaemon
described in the TUN contract. Ad-hoc app packages contain no production helper
and therefore keep packaged TUN unavailable.

`desktop:dev:tart-tun` is a separate acceptance-only entry point. It is valid
only in a disposable Tart guest after `pnpm macos:tun:install:tart` and exposes
the fixed development TUN policy to the authenticated repository RPC harness.
Ordinary `desktop:dev`, demo, ad-hoc, signed-direct, and production layouts
remain fail-closed. Never run the Tart command or installer on the host Mac.

## Authoritative details

- [Bootstrap and local-origin threat model](../../docs/architecture/desktop-bootstrap.md)
- [Frontend/platform ownership](../../docs/architecture/frontend-platform-boundary.md)
- [Settings](../../docs/architecture/settings-contracts.md)
- [Status bar and window lifecycle](../../docs/architecture/native-status-bar-lifecycle.md)
- [macOS TUN helper](../../docs/architecture/macos-tun-helper.md)
- [Packaging and signing](../../docs/operations/macos-packaging.md)
- [Native sidebar validation](../../docs/quality/native-sidebar-validation.md)
