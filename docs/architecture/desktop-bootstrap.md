# Desktop bootstrap and offline resource flow

## Decision

`apps/desktop` is a thin Tauri 2 shell around the shared `apps/web` product
entry. It embeds the Vite production output in the application binary, starts
the existing Rust loopback desktop bridge in-process, and exposes one narrowly scoped
bootstrap command to the main WebView. It does not own product state, controller
reconciliation, Mihomo lifecycle rules, System Proxy, TUN, or mobile execution.

An ordinary browser has no Tauri IPC surface. It continues to construct
`FixtureStatusClient`, performs no startup request, and labels all fixture values
and actions as demo state. The Tauri WebView alone constructs `RpcStatusClient`
after validating its private bootstrap payload.

## Local resource flow

1. `pnpm desktop:build` builds `apps/web/dist` before compiling the shell.
2. Tauri recursively embeds that directory through `build.frontendDist`.
3. The packaged WebView loads the application protocol; no CDN, remote font,
   hosted frontend, or runtime asset download is configured.
4. Tauri's embedded asset resolver serves exact assets and falls back to
   `index.html` for an unknown route so React Router can handle direct links.
5. During development, the shell explicitly loads `http://127.0.0.1:4173`, and
   Vite supplies the equivalent SPA fallback.
6. The shell obtains 32 bytes from the operating-system CSPRNG, hex-encodes the
   token, and starts `mish-bridge` on `127.0.0.1:0`.
7. The main WebView invokes `runtime_bootstrap`. Tauri's generated permission is
   granted only to that local window and returns `ws://127.0.0.1:<port>/rpc`
   plus the token in the IPC response body.
8. The Web client rejects non-IPv4-loopback, credentialed, queried, fragmented,
   non-WebSocket, or non-`/rpc` endpoints. It sends the token only in the first
   JSON-RPC authentication message.
9. The token remains in process memory for reconnect authentication. Neither
   side writes it to a file, URL, log, query string, fragment, cookie,
   `localStorage`, or `sessionStorage`.
10. When the Tauri event loop exits, the shell shuts down the in-process bridge.
    The runtime first closes and awaits any injected Status data source, then
    stops the core lifecycle, and finally closes the RPC server.

If a later slice moves frontend hosting to the local HTTP bridge, the host must
serve exact bundled assets, return `index.html` for unknown non-asset `GET` and
`HEAD` paths, and preserve ordinary `404` responses for missing asset filenames.
That change belongs to the bridge's HTTP interface and must not be recreated in
the Tauri shell.

## Threat model

The bootstrap protects against drive-by websites and other local processes that
guess a loopback port. The service binds only to IPv4 loopback, validates `Host`
and the exact development or packaged WebView `Origin`, uses an unpredictable
256-bit per-process token, requires authentication before other RPC methods, and
retains the bridge's message and subscription bounds. The endpoint contains no
secret, so URL histories, access logs, referrers, and routine network diagnostics
cannot reveal the token.

Tauri's capability grants no general filesystem, shell, dialog, event, or window
API. The production CSP permits only local bundled resources, Tauri IPC, and an
IPv4-loopback WebSocket. It blocks frames, objects, forms, remote fonts, and
remote frontend connections.

This boundary does not protect against compromise of the Mish process, a
compromised system WebView, injected code already executing in the trusted main
document, a debugger with process-memory access, or a malicious dependency in
the compiled frontend. Such code can invoke the bootstrap or inspect the token
after startup. The mitigation is a small IPC surface, strict CSP, local bundled
code, dependency pinning, endpoint validation, and no durable secret copy—not a
claim that process memory is a secure enclave.

## Current limitations

- The in-process bridge uses no Mihomo binary or configuration path, so it reports
  real but sparse local state and does not start the core automatically.
- The shared desktop composition can inject an explicit loopback Controller and
  publish read-only Controller-derived Status values. The desktop bridge also
  provides transactional activation and managed binary/resource resolution.
  The current Tauri shell deliberately supplies no selected persisted artifact,
  Controller policy, managed app-data root, or packaged sidecar, so it remains
  lifecycle-only and does not start Mihomo automatically.
- Network-changing Status commands remain unsupported.
- The Tauri shell has no status-bar menu or native sidebar material yet.
- Installer packaging, final icon production, entitlements, code signing,
  notarization, update metadata, and release distribution are not configured.
- The current bundle identifier is a development identifier and must be reviewed
  before signing or shipping.
