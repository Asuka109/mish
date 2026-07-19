# Desktop bootstrap and offline resource flow

## Decision

`apps/desktop` is a thin Tauri 2 shell around the shared `apps/web` product
entry. It embeds the Vite production output in the application binary, starts
the existing Rust loopback desktop bridge in-process, and exposes narrowly
scoped bootstrap, local-profile-picker, support-bundle, and local-backup commands to the main
WebView. It does
not own product state, controller reconciliation, Mihomo lifecycle rules,
System Proxy reconciliation rules, privileged TUN operations, or mobile
execution. It composes narrow macOS adapters into the shared runtime. The TUN
adapter currently exposes only the truthful unsigned/unpackaged non-production
boundary defined by [`macos-tun-helper.md`](macos-tun-helper.md).

An ordinary browser has no Tauri IPC surface. It continues to construct
fixture clients, performs no startup request, and labels all fixture values and
actions as demo state. The Tauri WebView alone constructs the Status, Profile,
Traffic, and Events RPC adapters after validating its private bootstrap payload.

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
   token, resolves Tauri's application-data directory, constructs the private
   profile repository, runtime root, and mode-`0600` System Proxy recovery
   journal there, and starts `mish-bridge` on `127.0.0.1:0` in the explicit safe
   stopped state.
   The bridge-handle slot is created before `run_return`; Tauri's `Ready` setup
   hook fills it before the WebView can invoke bootstrap, and the exit path later
   takes the same handle for ordered shutdown.
7. On macOS, the shell registers the documented `NSWorkspace` will-sleep and
   did-wake notifications and an `SCDynamicStore` callback for global IPv4/IPv6
   primary-service changes. These callbacks emit only a closed lifecycle event
   plus a process-local sequence number. Registration failure aborts desktop
   startup instead of silently claiming lifecycle recovery.
8. The main WebView invokes `runtime_bootstrap`. Tauri's generated permission is
   granted only to that local window and returns `ws://127.0.0.1:<port>/rpc`
   plus the token in the IPC response body. The same payload declares the
   desktop-only support-bundle and local-backup capabilities.
9. The native window remains hidden while React validates bootstrap and commits
   its first complete tree. The WebView then invokes the idempotent
   `reveal_main_window` command. Manual launches and login launches configured to
   show the window are revealed and focused; background login launches remain
   hidden. This public IPC handshake prevents the shell from exposing an empty
   WebView frame without relying on private WebKit presentation APIs.
   Before that reveal, the shell restores only a valid on-screen size, position,
   and maximized state. A previous hidden state is never restored.
10. The Web client rejects non-IPv4-loopback, credentialed, queried, fragmented,
    non-WebSocket, or non-`/rpc` endpoints. It sends the token only in the first
    JSON-RPC authentication message.
11. The bootstrap also declares whether the shell compiled with native macOS
    Sidebar material. The WebView uses this capability only to expose the matching
    sidebar/window-base pixels; product components do not branch on Tauri or the
    operating system.
12. The token remains in process memory for reconnect authentication. Neither
    side writes it to a file, URL, log, query string, fragment, cookie,
    `localStorage`, or `sessionStorage`.
13. Profile activation reloads a repository-owned valid artifact, resolves only
    the managed pinned binary, and commits the new runtime after Controller,
    Status and Traffic readiness plus an open redacted Events stream.
    Development accepts only an explicit
    `MISH_MIHOMO_BIN`; production resolves a packaged resource. Neither mode
    downloads a binary at runtime.
14. When the Tauri event loop exits, the shell shuts down the in-process bridge.
    The runtime invalidates any active diagnostic run, stops its capture audit
    loop, restores a still-confirmed
    Mish-owned System Proxy state, then the coordinator closes the active Status,
    Traffic, and Events sources, stops the core, and finally closes the RPC server.

Apple requires sleep and wake observers to use the `NSWorkspace` notification
center. Primary-service changes use notification keys in the SystemConfiguration
dynamic store rather than reachability polling or an application-owned network
probe. The event source watches only global IPv4/IPv6/DNS configuration keys; it does
not expose changed keys, service names, routes, or arbitrary network parameters
to RPC.
The same lifecycle coordinator invalidates the process-local Network and DNS
Settings observation before sleep, wake, primary-network changes, and Core
availability boundaries. Wake, network change, and healthy Core boundaries
request a new generation; late prior-generation results are discarded.

Local-file profile preflight uses a separate Tauri command granted only to the
main window. The command accepts no path from Web content: it opens the native
file picker itself, reads only the user-selected YAML file, and returns a
display-safe preview. Browser and fixture adapters report this operation as
unsupported.

Support bundle export uses two additional main-window commands. Preview creates
one exact, bounded, redacted JSON document in memory and caches it under an
opaque preview ID. Save accepts only that ID, consumes the cached document, and
opens Tauri's native save dialog itself. It accepts no caller path or contents.
The shell writes through a private same-directory temporary file and atomic
rename; cancellation writes nothing. Static, path-free errors are returned to
the WebView. The loopback RPC surface has no corresponding method.

Local backup and restore use the same narrow principle but a separate versioned
format and pending-preview state. Export commands accept only a closed scope DTO
and opaque preview ID. Restore preview opens the native picker itself and accepts
no Web-supplied path; commit accepts only the retained preview ID and a closed
conflict policy. The complete privacy, validation, and transaction contract is
defined in [`local-backup-restore.md`](local-backup-restore.md).

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

Tauri's capability grants no general filesystem, shell, dialog, event, or
window API to Web content. It grants only the generated bootstrap and
first-frame reveal commands plus the narrow profile-picker, support-bundle, and local-backup
commands described above; native dialogs, window reveal policy, and file writes
remain internal to those commands. The production CSP permits only local
bundled resources, Tauri IPC, and an IPv4-loopback WebSocket. It blocks frames,
objects, forms, remote fonts, and remote frontend connections.

The WebView cannot execute operating-system commands. Authenticated RPC accepts
only bounded capture DTOs and recovery actions. The macOS adapter maps those
DTOs to a closed command enum with fixed absolute executables and separate
arguments; it does not accept an executable path or arbitrary shell text from
RPC, profiles, or the UI.

This boundary does not protect against compromise of the Mish process, a
compromised system WebView, injected code already executing in the trusted main
document, a debugger with process-memory access, or a malicious dependency in
the compiled frontend. Such code can invoke the bootstrap or inspect the token
after startup. The mitigation is a small IPC surface, strict CSP, local bundled
code, dependency pinning, endpoint validation, and no durable secret copy—not a
claim that process memory is a secure enclave.

## Current limitations

- The in-process bridge does not start Mihomo automatically. It reports the
  explicit safe stopped state until a persisted valid profile is activated.
- The shared desktop composition can inject an explicit loopback Controller,
  publish Controller-derived Status, Traffic, and Events values, and reconcile
  bounded routing, group-selection, and active-connection commands. The desktop bridge also
  provides transactional activation and managed binary/resource resolution.
- The Tauri shell composes the Profile service, activation coordinator, private
  application-data runtime root, and managed binary resolver. A missing explicit
  development binary or production resource remains visibly unavailable.
- The shell deliberately does not guess or restore a last profile at startup.
  A future restore policy requires an explicit recorded policy and the same
  transactional failure recovery; it may not enable System Proxy or TUN.
- System Proxy and TUN are the bounded network-changing Status commands. Both
  default off; TUN additionally requires a healthy signed helper and explicit
  user selection,
  requires a healthy configured core and reachable application-owned mixed
  proxy listener, confirms every applied change, and restores only state
  recorded in its private journal. The generated Mihomo configuration and the
  macOS adapter share that same managed loopback endpoint. All other
  network-changing Status commands remain unsupported.
- The macOS shell has a native status-bar menu backed by the same runtime host,
  capture reconciler, and profile activation coordinator as authenticated RPC.
  It deliberately links to Routes instead of duplicating the complete policy-group
  child tree, and the ordinary browser client remains unavailable because the
  bridge does not host the product bundle.
- The macOS application bundle uses the stable identifier
  `com.asuka109.mish`, embeds the pinned Apple Silicon Mihomo resource, and can
  be ad-hoc signed for main-branch testing. Developer ID signing and
  notarization remain credential-gated production operations documented in
  [`../operations/macos-packaging.md`](../operations/macos-packaging.md).
- The Apple Silicon bundle includes exact copies of the repository GPL-3.0-only
  license and Mihomo attribution/source notice. Packaging verification fails if
  either resource is absent or altered.
- A production TUN helper is not yet embedded. The reserved signing identifier
  is `com.asuka109.mish.tun-helper`; ad-hoc test packages continue to report the
  helper as unpackaged and cannot enable TUN.
