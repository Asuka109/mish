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

An ordinary browser has no Tauri IPC surface. Browser startup always attempts an
authenticated same-origin bootstrap and renders a dedicated pairing page when
no valid browser session exists; production startup never constructs fixture
clients. A browser explicitly launched from the macOS status-bar menu loads the
same offline bundle from the desktop bridge and exchanges a one-time fragment
capability automatically. Source development prints a separate process-lifetime
fragment capability so the same console URL can open multiple clean browser
contexts until a replacement process starts. A direct bridge URL requests a human-entered PIN from the
desktop app. Both paths construct the Status, Profile, Traffic, Events,
Diagnostics, and Settings RPC adapters only after authentication. The Tauri
WebView uses a separate private IPC bootstrap for those adapters.

Source development exposes fixtures only through `pnpm demo` and
`pnpm desktop:demo`. The browser command selects fixtures before any bootstrap
request. The desktop command uses the isolated `com.asuka109.mish.demo`
identifier and a minimal Tauri shell that exposes only window reveal plus safe
native window interactions. It does not validate or start Core, resolve the
operational app-data directory, acquire the managed-runtime lease, construct the
bridge or platform adapters, register lifecycle observers, or install the
operational status bar. Missing or failed authentication in every non-demo mode
still fails closed and never selects fixtures.

## Local resource flow

1. `pnpm desktop:build` builds `apps/web/dist` before compiling the shell.
2. Tauri recursively embeds that directory through `build.frontendDist`.
3. The packaged WebView loads the application protocol; no CDN, remote font,
   hosted frontend, remote script, or runtime asset download is configured.
   The sole remote-resource exception is a user-configured service-monitor
   image accepted by the constrained policy in the threat model below; it is
   not a frontend or executable asset.
4. Tauri's embedded asset resolver serves exact assets and falls back to
   `index.html` for an unknown route so React Router can handle direct links.
5. During development, the launcher selects the first available IPv4-loopback
   port from 4173 and supplies the same exact origin to Vite, Tauri's `devUrl`,
   and the bridge allowlist. Vite supplies the equivalent SPA fallback. The
   development command first builds `apps/web/dist` so the bridge can serve a
   deterministic browser-client artifact through Tauri's asset resolver while
   a later explicitly created WebView uses Vite HMR. The operational launcher
   enables a source-development-only Cargo feature that retains `main` as a
   dynamic window template with `create:false`. Demo and every build, bundle,
   packaged, production, updater, and login-launch command omit that feature.
   On macOS the headless process uses the Accessory activation policy until an
   explicit trigger requests a window, preventing a windowless launch from
   activating the application or taking focus.
6. The shell obtains 32 bytes from the operating-system CSPRNG, hex-encodes the
   token, and resolves Tauri's application-data directory. It first acquires
   the managed runtime's process-held single-instance lease without performing
   Profile, Core, Capture, or platform reconciliation. Its first
   application-owned reconciliation then opens the versioned private updater
   maintenance journal. A pre-install record is safely cancelled; an unknown
   install outcome, old/unexpected version, corrupt record, or incompatible
   schema blocks every automatic Profile/Core/Capture launch without replaying
   installation. The same `configured:false` updater authority is later shared
   by the WebView and Browser Client. Only after this barrier does startup construct the private
   profile repository, runtime root, and mode-`0600` System Proxy recovery
   journal there. A second desktop instance sharing that app-data root fails startup
   before Profile, Settings, backup, Core, or System Proxy recovery can mutate
   state. A normal sequential application upgrade acquires the lease after the
   prior desktop process exits; repository fixtures use separate temporary or
   in-memory roots. Before exposing `mish-bridge`, startup recovers any strongly
   confirmed orphaned managed Core and then synchronously audits the System
   Proxy journal with the safe-stopped runtime. A confirmed orphaned Mish proxy is
   restored to its recorded prior state; an unreadable or unconfirmed record
   remains explicit recovery drift and cannot be published as off or applied.
   The Browser Client bridge starts at `127.0.0.1:6474` on every application
   launch, advancing one port at a time only when the prior loopback address is
   already in use. It retains the first listener it binds rather than probing
   and rebinding.
   The bridge-handle slot is created before `run_return`; Tauri's `Ready` setup
   hook fills it without requiring a WebView, and the exit path later takes the
   same handle for ordered shutdown. Operational source development then prints
   one authenticated Browser Client URL and one current-process desktop-window
   trigger URL with stable prefixes. Both development URLs remain reusable by
   their intended flows until the process is replaced.
7. On macOS, the shell registers the documented `NSWorkspace` will-sleep and
   did-wake notifications and an `SCDynamicStore` callback for global IPv4/IPv6
   primary-service changes. These callbacks emit only a closed lifecycle event
   plus a process-local sequence number. Registration failure aborts desktop
   startup instead of silently claiming lifecycle recovery.
8. When a main WebView exists, it invokes `runtime_bootstrap`. Tauri's generated permission is
   granted only to that local window and returns `ws://127.0.0.1:<port>/rpc`
   plus the token in the IPC response body. The same payload declares the
   desktop-only support-bundle and local-backup capabilities.
9. Packaged, production, demo, login-launch, and other normal window paths keep
   their configured creation behavior. The native window remains hidden until the WebView installs the document
   startup placeholder: a quiet, centered Mish mark on the window surface.
   Before the placeholder can become visible, one synchronous repository-owned
   `/appearance-bootstrap.js` asset reads only the bounded
   `mish.appearance` browser hint. It accepts `light`, `dark`, or `system`,
   resolves system appearance through the local media query, and otherwise
   falls back safely to system/light. The same asset sets only the document
   theme, color scheme, and theme-color metadata. It is an independent Vite
   build entry with a fixed self-hosted path, so both the packaged WebView and
   Browser Client can execute it under `script-src 'self'` without a nonce,
   hash, inline execution, or remote source.

   The startup module immediately invokes the idempotent
   `reveal_main_window` command without waiting for image decoding, animation
   frames, the React bundle, bridge bootstrap, or first application tree.
   React replaces the placeholder when it commits. Manual
   launches and login launches configured to show the window are revealed and
   focused; background login launches remain hidden. This public IPC handshake
   prevents the shell from exposing an empty WebView frame without relying on
   private WebKit presentation APIs.
   Before that reveal, the shell restores only a valid on-screen size, position,
   and maximized state. A previous hidden state is never restored.

   The hint is not Settings authority. Authenticated bootstrap still returns
   the Rust-validated Settings snapshot before React renders application UI.
   That value replaces a missing, corrupt, stale, or unavailable browser hint,
   updates the cache, and projects through the existing Appearance provider.
   DOM writes are idempotent, so a matching hint hands off without a duplicate
   theme transition while a stale hint converges once to Rust authority.

10. The Web client rejects non-IPv4-loopback, credentialed, queried, fragmented,
    non-WebSocket, or non-`/rpc` endpoints. It sends the token only in the first
    JSON-RPC authentication message.
11. The bootstrap also declares whether the shell compiled with native macOS
    Sidebar material. The WebView uses this capability only to expose the matching
    sidebar/window-base pixels; product components do not branch on Tauri or the
    operating system.
12. The RPC token remains in process memory for reconnect authentication.
    Neither side writes it to a file, URL, log, query string, fragment, cookie,
    `localStorage`, or `sessionStorage`. Browser storage contains only an
    independently random origin proof; the HttpOnly cookie contains only an
    independently random, process-local browser-session token.
13. Profile activation reloads a repository-owned valid artifact, resolves only
    the managed pinned binary, and commits the new runtime after Controller,
    Status and Traffic readiness plus an open redacted Events stream.
    When `MISH_MIHOMO_BIN` is unset, `desktop:dev` prepares and verifies the
    repository-pinned Core. An explicit absolute local override is preserved
    only after its file type, mode, executable bit, host, and required version
    pass development validation; invalid explicit input fails without fallback.
    Tauri revalidates file type and mode plus the pinned digest when applicable;
    production resolves and verifies a packaged resource. No application
    runtime downloads a binary.
14. Every supported normal quit request first enters one shell-owned,
    one-shot graceful-exit coordinator. It prevents Tauri exit while cleanup is
    pending, stops accepting new state mutations, stops capture auditing,
    restores and confirms a still-owned System
    Proxy state, stops and reaps Core, and finally closes the RPC server. The
    bridge returns a bounded typed report instead of swallowing activation,
    capture, Core, server, or task-join failures. Only a fully confirmed report
    authorizes the final Tauri exit request. A failure keeps Mish alive with a
    native actionable recovery alert. Cleanup after `run_return` remains an
    idempotent abnormal-boundary fallback rather than the normal quit path.
    The coordinator and fallback are initialized before any optional WebView,
    so signal, Ctrl-C, status-bar Quit, and abnormal runner exit retain the same
    Core, Capture, RPC, privileged ownership, and task-join ordering while
    development remains headless.
15. Before Tauri creates the configured `main` window, one typed startup-options
    parser resolves the process-local WebView Inspector contract. `--devtools`
    has precedence over `MISH_DEVTOOLS`; without the flag, only exact values `1`
    and `0` are accepted. Missing input defaults off, and malformed input aborts
    before window creation with a bounded diagnostic that states the Inspector
    remains disabled. The resolved value overrides the final merged window
    configuration, while the checked-in base configuration also explicitly
    defaults `devtools` to `false`.
    Supported macOS opt-in launches Tauri's local WebKit Inspector only for the
    configured desktop WebView. The value is not part of `RuntimeBootstrap`,
    Settings, browser storage, app data, or any RPC contract, so a later process
    without an opt-in is closed again. Unsupported desktop platforms reject an
    enable request instead of claiming success. The boundary adds no browser
    argument, remote-debugging port, listener, Browser Client capability,
    bridge bypass, CSP change, or RPC authorization change.
    This uses the pinned
    [`WebviewWindow::open_devtools`](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindow.html#method.open_devtools)
    API and follows Apple's per-WebView, default-off
    [`WKWebView.isInspectable`](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable)
    lifecycle rather than creating a remote debugging service.
    The two source-development package commands load the tracked
    `apps/desktop/.env.development`, which deliberately provides
    `MISH_DEVTOOLS=1`. Demo opens Inspector with its normal window. Operational
    development creates neither the WebView nor Inspector until the explicit
    desktop-window trigger constructs the dynamic `main` window. An existing
    process environment can override it with `MISH_DEVTOOLS=0`. Build, bundle,
    packaged launch, Finder, Dock, and Login Item paths never load that file, so
    the application binary and every packaged workflow retain the default-off
    contract.

## Development desktop-window trigger

The trigger reuses the already-bound Browser Client listener and is compiled
only with the operational source-development feature. It adds no listener,
deep link, production capability, RPC method, setting, persisted state, or
packaged route. The emitted URL uses exact `127.0.0.1` authority and carries an
independent 256-bit base64url capability only in its fragment. The HTTP server
therefore never receives the capability in a GET target, referrer, or query.

The development-only page has a self-only CSP, no inline executable content,
no storage, no cookies, no RPC bootstrap, and no external resource. Its module
removes the fragment before sending a bounded same-origin JSON request with the
capability and a fresh 256-bit request ID. Rust requires an IPv4-loopback peer,
the exact numeric Host, the exact same Origin, fixed field shapes, a constant-
time capability match, and an unused request ID. The current capability remains
valid for its owning process until replacement or shutdown. It retains at most
64 request IDs and rejects exact replay, malformed input, wrong process
capability, non-loopback authority, origin drift, and saturation without
invoking Tauri. The RPC token, Browser Client
launch token, PIN, browser session, and origin proof are separate authorities.

Accepted requests call one Rust window controller. Its serialized creation
claim and fixed `main` label make concurrent construction idempotent. An absent
window is built on Tauri's main thread from the checked configuration; an
existing window is shown, unminimized, and focused. The normal WebView-ready
handshake still prevents an empty frame. In this development mode a close
request hides the window regardless of the stored production close preference,
returns the process to Accessory activation, and leaves the backend and current
trigger available. Status-bar navigation, application-menu navigation and Find,
and Dock reopen requests queue their intent through the same controller when the
window does not exist; the ready handshake delivers the queued action. Process
replacement discards the capability, replay set, pending creation claim, and
window together, so a hot restart remains hidden and earlier URLs fail closed.
Browser Client pairing, PIN, and one-time launch-token expiry remain separate
and unchanged.

## Browser-client launch flow

The bridge exposes the bundled Web artifact only on its ephemeral IPv4-loopback
origin. Exact `GET` and `HEAD` assets use Tauri's resolver, unknown extensionless
paths fall back to `index.html`, and missing asset filenames return `404`. Asset
responses disable storage and referrers, disallow framing and privileged browser
features, restrict scripts, styles, fonts, images, and WebSocket connections to
the local application origin, and never depend on a CDN.

Each production `Open Browser Client` action creates a fresh 256-bit, 43-character
base64url launch token, stores it in a bounded two-minute process-memory queue,
and places it in the URL fragment. The actual RPC token and endpoint never
appear in the URL. `pnpm desktop:dev` instead prints one independently random
development token that remains reusable only for the lifetime of that desktop
process. Issuing a replacement development URL revokes the prior development
token, and process replacement discards it. Production launch tokens remain
two-minute and one-time. Browser startup posts the launch token plus a fresh origin
proof to `/browser-bootstrap` from the
same origin, and the bridge validates the loopback peer, exact Host, exact
Origin, and token in constant time before consuming it. Before React Router can
render or redirect, Browser startup accepts the fragment on the root, every
stable product destination, and recognized Routes group paths. It removes the
fragment with same-entry history replacement while preserving the requested
path and query. Unknown paths and malformed tokens do not enter the launch
exchange, but their token-shaped fragments are still removed before the
authentication fallback renders. A successful production token cannot be replayed;
the current development-console token can establish multiple independent browser
sessions. An invalid token does not consume or revoke a valid pending token. The high-entropy token is
not guarded by the low-entropy manual PIN's attempt lockout. The response is
non-cacheable and contains the RPC bootstrap in its body; the Web client retains
the RPC token only in memory.

A direct browser visit first attempts `/browser-bootstrap`. Without a valid
session it renders the pairing page and posts to `/browser-pairing`. The bridge
keeps at most one pending challenge, obtains a six-digit PIN from the operating
system CSPRNG, gives it a two-minute lifetime and five attempts followed by a
one-minute process lockout, and asks the
injected native prompt adapter to display it. `/browser-pairing/complete`
validates the opaque challenge ID and PIN in constant time and consumes the
challenge before returning the bootstrap.

Both exchanges establish a fresh scoped HttpOnly, SameSite session cookie whose
value is independently random rather than a launch token, manual PIN, or RPC
token. The session is accepted only together with a second random proof in
origin-scoped `localStorage`. This split is required because cookies do not
isolate ports while browser origins do. The bridge accepts only a bounded set of
process-local browser sessions and applies the same loopback, Host, Origin,
cookie, and proof checks to every refresh. If either half is gone, the page
returns to pairing and cannot claim an authenticated RPC runtime.

After the browser has reached an authenticated RPC connection, exhaustion of
the bounded WebSocket reconnect policy replaces the application shell with a
browser-only disconnected surface. The surface shows the validated bootstrap
port in an editable numeric field and keeps all stale product controls
unmounted. **Connect** checks the versioned Mish marker on only the valid port
currently shown in the field and navigates only after that exact-port check
succeeds. **Scan** checks IPv4-loopback ports sequentially from 6474, writes the
first securely identified Mish port back to the field, and then invokes the
same Connect path. The scan stops after 10 occupied non-Mish ports or 5 empty
ports, whichever occurs first, and retains bounded per-request timeouts and an
overall deadline.

Settings reconnects remain stale until a complete protocol-35 baseline is
accepted. That baseline carries the replacement Rust authority and may have a
lower durable preference revision than the retired process. Socket-local
subscription IDs, client subscription generations, and the Settings authority
order jointly reject late responses or notifications from the retired
transport without clearing a global revision or resetting React state.

Browser-hosting bridges expose `GET /browser-discovery` solely as a versioned
service marker. The marker contains no RPC token, PIN, proof, session, settings,
or process data. Cross-port reads accept only HTTP origins on
`127.0.0.1:6474` or above and use no credentials; all authenticated bootstrap
and RPC routes retain their existing exact Host, Origin, cookie, proof, and
token checks. If a marker request is blocked by CORS, a credential-free opaque
request classifies a listener as occupied when browser policy permits; an
ambiguous network or policy failure counts against the empty-port budget. The
opaque response can never authenticate or select a listener. Only a matching
marker causes a fragment-free replacement navigation
to the discovered origin. Origin-scoped proof storage is not copied, and a new
or restarted process must pass through the existing pairing flow when its
process-local session is no longer valid.

The browser client shares the desktop runtime but cannot acquire Tauri-only
capabilities. Native local-file import, support-bundle export, local backup and
restore, native Sidebar material, and native window lifecycle are reported as
unavailable. HTTPS profile import and all authenticated RPC operations continue
to use the same desktop application services and typed capability checks as the
WebView. Virtual Interface and Helper lifecycle are authenticated RPC operations,
not Tauri-only capabilities: the paired loopback Browser Client receives the same
Rust projection and requests the same install, repair, removal, Capture,
rollback, recovery, and terminal read-back authority as the WebView. Browser
JavaScript never installs a Helper or performs a privileged or network mutation.
A backend-free fixture, invalid or expired Browser session, wrong Origin,
non-loopback peer, unsupported platform, or desktop composition without a valid
backend remains unavailable before any effect.

Managed Core recovery precedes every activation and managed-listener readiness
probe. Startup never restores the recorded profile automatically: it terminates
and waits for a proven orphan, clears Core ownership, performs conservative
System Proxy recovery, and publishes the existing safe-stopped policy.

## Aggregate proxy command authority

The desktop `ProfileActivationCoordinator` owns one transport-neutral aggregate
launch command. The authenticated Web RPC supplies the explicitly selected
Profile when launching from the sidebar; application startup and a future
native status-menu caller supply no Profile and therefore resume the last
successful Profile. The coordinator runs Profile activation through the
repository state-machine kernel: the pure reducer owns command scope/revision,
Profile revision/fingerprint, runtime authority, cancellation, finalization,
and compensation, while bounded effects own Core and Capture work. A running
Capture switch is admitted as the same saga and reaches Success only after the
new runtime is authoritative and the requested Capture state is observed as
Applied against it. An activation without running Capture retains the existing
separate Capture behavior.
If Capture fails after that command started a previously stopped Core, the same
aggregate operation restores Capture, stops and reaps that Core, clears its
active managed identity, and publishes a capture-typed safe-stopped activation
state before returning the original failure. If safe stop itself fails, the
aggregate result becomes Recovery Required with the last authoritative runtime
and Capture evidence. A Core that was already active before the aggregate
command is restored as the exact prior runtime instance after a failed atomic
backend switch and is not stopped by a later independent Capture failure.
Stopping continues to use the established Capture stop path so System Proxy
restoration is unchanged.

Settings persist the last explicitly selected Capture combination independently
from the opt-in `launchBehavior` preference. Changing either preference never
starts Core or proxy capture immediately. At automatic launch, `core` resumes
the last successful Profile without capture, while `proxy` resumes it and applies
System Proxy capture. The default remains `off`, and changing the preference
never mutates the current runtime.

The private runtime root contains `core-ownership.json` and
`desktop-instance.lock`. Core ownership is a bounded, versioned,
deny-unknown-fields record replaced through a unique mode-`0600` file, atomic
rename, file flush, and directory flush. A launch-intent record is durable
before spawn, and the running record adds the PID and process start identity
after spawn. Both phases bind a random per-launch token, the exact launched
executable, and the exact candidate home and configuration paths. Invalid,
oversized, non-private, symlinked, path-escaping, ambiguous, or
identity-mismatched records fail closed with a static redacted startup error and
remain available for investigation.

On macOS, recovery confirms the recorded PID/start time, executable path,
`-d`/`-f` arguments, and inherited launch token before signaling. A pre-PID
launch record can discover only a process matching that same executable,
arguments, and token. PID reuse, user-started Mihomo, process-name matches, and
port ownership alone are never termination authority. Normal Stop/Quit sends
TERM, awaits the child, escalates to KILL only after the bounded grace period,
awaits reap, and clears only the matching ownership generation. After an
abnormal desktop exit, the next lease owner applies the same identity checks,
terminates and waits for the orphan, and clears ownership before any new Core
can start.

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

The local HTTP bridge hosts the browser-client artifact through the Tauri asset
resolver. This ownership keeps exact asset lookup and SPA fallback in one bridge
interface instead of recreating a second filesystem or static-file server in the
Tauri shell.

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
remain internal to those commands. The production CSP permits local bundled
scripts and resources, Tauri IPC, and an IPv4-loopback WebSocket. Its narrowly
scoped `img-src` exception also permits HTTPS images. It blocks inline or remote
script execution, frames, objects, forms, remote fonts, remote frontend
connections, and any additional IPC authority.

That HTTPS image exception is only for a service-monitor icon rendered by the
Web client's `img` element. The accepted value is either one of the recorded
root-relative bundled Remix Icon paths, or an HTTPS URL no longer than 2,048
characters with a host and with both username and password omitted. It rejects
HTTP, `file:`, `javascript:`, unknown bundled paths, malformed values, and URL
credentials. The image request uses `referrerPolicy="no-referrer"`; the bridge
does not fetch or proxy it, and no Mish RPC token, bootstrap token, profile
credential, or URL userinfo is put in the icon URL. This is not a generic URL
loader and does not authorize remote code, a remote frontend, a frame, a form,
font, WebSocket, or IPC operation.

The privacy boundary is deliberately residual rather than absolute: a remote
icon host can observe a direct image request, including network metadata such
as the client address, timing, and ordinary WebView request characteristics.
`no-referrer` prevents the document URL from being sent as a referrer, and the
accepted URL omits embedded credentials; neither fact makes the remote host
local or trusted. Built-in service icons stay bundled and root-relative.

The WebView cannot execute operating-system commands. Authenticated RPC accepts
only bounded capture DTOs and recovery actions. The macOS adapter maps those
DTOs to a closed command enum with fixed absolute executables and separate
arguments; it does not accept an executable path or arbitrary shell text from
RPC, profiles, or the UI.

The authenticated Status surface also exposes one Settings-configured local proxy listener
test. It accepts empty parameters and performs only bounded TCP readiness against
the application-owned loopback endpoint after confirming that the current
managed runtime identity owns that listening socket. A listener owned by an old
Mish orphan or any external process is `listener-unavailable`, never `ready`.
It does not call System Proxy
observation or application. Arbitrary remote pages remain excluded from the
trusted main WebView; the safe subset and isolated developer-mode follow-up are
defined in [`local-proxy-debugging.md`](local-proxy-debugging.md).

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
  default off and require explicit user selection. System Proxy requires a
  healthy configured core and reachable application-owned mixed-proxy listener.
  Source-development TUN requires the explicitly installed healthy development
  service; packaged TUN requires the signed embedded `SMAppService` boundary.
  Each command confirms applied state and restores only state recorded in its
  private journal. That journal uses a strict versioned
  application-owner envelope, rejects non-private, foreign, stale, malformed,
  oversized, and symlink records, and is replaced through a unique mode-0600
  temporary file plus file and directory flushes. The generated Mihomo
  configuration and the macOS adapter share that same managed loopback endpoint. All other
  network-changing Status commands remain unsupported.
- The macOS shell has a native status-bar menu backed by the same runtime host,
  capture reconciler, and profile activation coordinator as authenticated RPC.
  It deliberately links to Routes instead of duplicating the complete policy-group
  child tree, and it opens the real browser client through a one-time same-origin
  bootstrap without exposing the RPC token in a URL.
- The macOS application bundle uses the stable identifier
  `com.asuka109.mish`, embeds the pinned Apple Silicon Mihomo resource, and can
  be ad-hoc signed for main-branch testing. Developer ID signing and
  notarization remain credential-gated production operations documented in
  [`../operations/macos-packaging.md`](../operations/macos-packaging.md).
- The Apple Silicon bundle includes exact copies of the repository GPL-3.0-only
  license and Mihomo attribution/source notice. Packaging verification fails if
  either resource is absent or altered.
- Developer ID packaging embeds the production-only
  `com.asuka109.mish.tun-helper` executable and its exact `SMAppService`
  LaunchDaemon plist. The app advertises TUN only after exact Developer ID
  identity/team, registration, helper version, protocol, health, and freshly
  confirmed disabled-state checks. The missing production XPC health transport
  therefore remains recovery-required. Ad-hoc packages omit the privileged
  artifacts, report the helper as unpackaged, and cannot enable TUN.
- Apple Silicon source development can explicitly install
  `com.asuka109.mish.tun-helper.dev` as a root LaunchDaemon. When its bounded
  per-user socket and exact version are healthy, the development composition
  delegates the complete Mihomo process lifecycle to that service. Switching
  the TUN selection regenerates the active profile and restarts Core through the
  same activation transaction used by RPC and the native status-bar menu.
