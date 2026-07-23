# Native status bar and window lifecycle

## Decision

On macOS, Mish installs one Tauri status-bar icon and keeps the desktop bridge,
runtime host, profile activation coordinator, capture audit loop, and managed
core alive when the main window is hidden. The menu is a native projection of
the same `DesktopRuntimeHost` and `ProfileActivationCoordinator` used by the
authenticated Web RPC surface. It does not own a second application-state
store.

The menu subscribes to runtime replacement, core/status updates, capture
reconciliation updates, and profile activation updates. It is constructed once
and retains native item handles. Menu-visible operation state updates in place
after authoritative updates; a one-second local timer updates only the three
read-only status item texts. The timer never polls the Controller or Traffic:
it reads the private route-activity summary and the most recent authoritative
`StatusSnapshot` Traffic rates. Pending and failed aggregate operations remain
explicit and are never converted into a local success.

The tray icon is also a projection of that same reconciled `StatusSnapshot`:
it uses a subdued 45%-alpha monochrome template mask only when both System Proxy
and TUN are authoritatively inactive, and switches to the full-alpha mask when
either is enabled. The tray handle is retained with the menu item handles, and
only this aggregate boolean edge replaces the icon; traffic updates, pending
commands, Core state, and remembered capture preference do not. Both masks stay
macOS templates, so the operating system supplies contrast for light, dark, and
highlighted menu-bar appearances.

## Menu surface

The implemented compact surface has four separator-delimited sections:

1. One aggregate **Launch proxy** / **Stop proxy** command. It uses the same
   `ProfileActivationCoordinator` launch and capture authority as Web/sidebar
   controls and automatic launch. Starting resumes the remembered available
   System Proxy/TUN selection; stopping preserves that selection while making
   capture inactive. Native code does not recreate capture sequencing. Pending
   is disabled and labelled accordingly; failures are labelled as failed but
   remain retryable when the coordinator is available.
2. Fixed native navigation: **Open Mish** (the Status destination), **Routes**,
   **Profiles**, **Traffic**, **Events**, and **Settings**. Routes has no node
   activity suffix. Navigation accepts only this allowlist and shows,
   unminimizes, and focuses the existing WebView.
3. Three disabled, read-only live labels immediately below navigation: **Most active node**, **Download**,
   and **Upload**. The node label is the existing bounded, redacted trailing
   60-second summary. Download and Upload use `StatusSnapshot.traffic` rates
   and the established binary byte-rate convention. Missing or non-ready
   Traffic is **Unavailable**; a ready snapshot with no qualifying route is
   **Idle**. These handles update in place once per second and never replace
   the tray menu.
4. **Open Browser Client**, followed by a checked **Auto-start proxy on app
   launch** preference and then **Quit Mish**. The preference writes only the
   existing next-launch setting; it does not launch a Profile or mutate capture
   immediately.

Current Profile, Core, System Proxy, Repair, Leave, TUN, Routing Mode, and
Recover Core are deliberately absent from this native surface. Their product
functions remain available elsewhere in Mish.

`Open Browser Client` creates a fresh high-entropy one-time launch token and
opens the desktop bridge's bundled-asset origin in the default browser. The
token is not the RPC credential, is consumed by an Origin-validated bootstrap
request, and is carried in the URL fragment and removed from the address bar immediately. A
scoped HttpOnly session plus an origin-scoped browser proof permits refresh
without persisting the RPC credential. Full policy-group child selection
is not duplicated in the native menu in this slice. `Open Routes` remains the
native progressive-disclosure path.

Successful launch is visible as the newly opened browser window. CSPRNG, launch
state, invalid-URL, or operating-system open failures display a native warning
dialog with an accessible message and safe retry instruction; they do not
silently leave a dead menu command or expose a credential for manual recovery.

The menu never includes node identifiers, service URLs, authentication tokens,
filesystem paths, controller addresses, RPC endpoints, or private runtime
details. A later menu item may show one narrowly scoped exception: a bounded,
trimmed, display-safe **user-authored terminal node label** derived from the
authoritative typed Traffic snapshot and Status node catalog. The native
projection counts only each connection's first observation in the current
profile/session, stores those events in a private fixed-capacity observation
ring, and derives the strict trailing 60-second node count from that log using a
monotonic clock. It retains no raw connection IDs in events: a private,
session-scoped fingerprint index prevents duplicate snapshots and long-lived
connections from being counted again even after event eviction. A future menu worker
records authoritative snapshots as they arrive and re-evaluates this in-memory
projection once per second, so the displayed result expires on the strict
boundary without polling or duplicating Traffic authority. It exposes no
connection IDs, route labels, destinations, process data, addresses, profile
IDs, Controller data, or raw chains. It produces no result for stale,
unavailable, missing-session, or unsafe data; resets on profile/session
replacement; and breaks equal counts by safe label order. A ready empty
snapshot updates current-active tracking but does not erase valid events inside
the requested rolling window. Capacity, rather than elapsed time, determines
retention under heavy traffic.
Labels with URLs, endpoints, paths, controls, addresses, credential-like text,
or excessive input length are rejected. Otherwise labels are bounded and
Unicode-safe truncated before display. Native navigation accepts only a fixed
set of product destinations.

## Window lifecycle

`windowCloseBehavior` is a durable application preference independent from
`launchAtLogin` and `loginLaunchBehavior`:

- `hide-to-status-bar` is the safe default. A close request is prevented and the
  existing main window is hidden. The WebView is not the owner of the runtime,
  bridge, capture reconciler, or status menu.
- `quit` enters the shell-owned graceful-exit coordinator. The coordinator
  claims shutdown once, rejects repeated or racing quit requests, cancels
  active profile work, stops capture auditing, conservatively restores and
  confirms Mish-owned System Proxy state, stops and reaps the managed core,
  and closes RPC. Tauri process exit is requested only after the typed bridge
  report confirms every stage. A failed stage keeps Mish alive, reveals the
  Status destination, and presents a native recovery alert; choosing Quit
  again retries the idempotent boundary after the reported state is resolved.

Login launch behavior still applies only to launches carrying the fixed login
startup argument. A manual launch shows the window regardless of that setting.
The shell now defers that initial reveal until the WebView has validated desktop
bootstrap and React has committed its first tree. A bounded `reveal_main_window`
command applies the previously computed login-launch policy, so the WebView
cannot promote a background login launch into a visible window.
Opening any fixed destination from the status bar shows, unminimizes, and
focuses the existing window.

The native shell persists only the main window's size, valid on-screen position,
and maximized state. It does not persist visibility or fullscreen state. This
keeps multi-monitor restoration bounded to a currently available display and
prevents a prior hide-to-status-bar action from making the next manual launch
invisible. A Dock reopen with no visible windows reveals, unminimizes, and
focuses that same main window.

Tauri's standard macOS application menu retains native About, Services, edit,
window, fullscreen, hide, and close behavior. Mish replaces only the predefined
AppKit `terminate:` Quit item with an application-owned **Quit Mish** item using
Command-Q. That item, the status-bar Quit item, `windowCloseBehavior=quit`, and
normal programmatic exit requests all enter the same graceful-exit coordinator.
The application-wide menu listener also recognizes the status-bar Quit ID as a
backstop because Tauri menu listeners receive events from window and tray menus.
Duplicate delivery is harmless because the coordinator admits one shutdown.
The status menu is constructed once. Mish retains its native item handles and
updates text, checked state, and enabled state in place when a menu-visible field
changes. It never replaces the tray menu after startup, so high-frequency status
updates cannot close an open menu through `set_menu`.
Mish inserts Settings with Command-, and Find with Command-F. The status menu
adds application-local accelerators only for its high-frequency executable
commands: Command-Shift-P for the aggregate proxy command, Command-0 through
Command-4 for Open Mish and fixed navigation, and Command-Shift-B for Open
Browser Client. Settings and Quit retain their standard Command-, and Command-Q
commands; read-only status, dynamic node values, the startup preference, and
recovery actions have no accelerators. These are native menu accelerators, not
system-wide global hotkeys: they are active only while Mish is the foreground
application and dispatch through the same stable menu IDs as pointer selection.
Settings routes to the fixed Settings destination; Find focuses only a page
control explicitly marked as the native search target. Web fallback handling
accepts Command shortcuts on macOS and does not reinterpret Control-F or
Control-, as their Command equivalents.

## Menu convention references

The status menu borrows interaction patterns, not code or copy, from public
first-party sources reviewed on 2026-07-23:

- [Clash Verge Rev's tray menu definition](https://github.com/clash-verge-rev/clash-verge-rev/blob/dev/src-tauri/src/core/tray/menu_def.rs)
  uses stable IDs for native tray commands; its tray updater projects checked
  state separately.
- [Clash Nyanpasu's native tray implementation](https://github.com/libnyanpasu/clash-nyanpasu/blob/main/backend/tauri/src/core/tray/mod.rs)
  keeps a conventional Command-Q quit command in the tray.
- [Mihomo Party's tray menu](https://github.com/mihomo-party-org/mihomo-party/blob/smart_core/src/main/resolve/tray.ts)
  explicitly associates menu accelerators with executable actions; its separate
  `globalShortcut` implementation demonstrates why Mish must not treat those
  menu accelerators as system-wide hotkeys.
- [Apple's menu customization guidance](https://developer.apple.com/tutorials/app-dev-training/customizing-menus-with-commands-and-shortcuts)
  describes menu keyboard shortcuts as alternate workflows for frequent
  application commands. Command-, and Command-Q retain their conventional
  Settings and Quit assignments.

The independent **🔥** prefix makes the most-active-node row faster to scan
without changing its user-authored node label, **Idle** / **Unavailable**
fallbacks, or once-per-second local projection.

After a route change, the WebView moves programmatic focus to the page heading
without scrolling and updates the document title. This gives VoiceOver a stable
announcement target while keeping pointer and keyboard navigation on the same
React route tree.

Unsupported platforms and the browser fixture advertise both status-bar and
window-lifecycle capabilities as unavailable and cannot report native-operation
success.

## Verification

Deterministic tests cover one-shot shutdown under racing quit sources, native
Quit ownership, status-bar and window-close routing, programmatic-exit
interception, exact report gating, capture/journal and Core-stop failures, and
idempotent post-run fallback. Existing coverage also includes settings migration and persistence, independence from
login launch behavior, authenticated bounded RPC, browser capability fallback,
the exact compact section/item model, fixed native navigation destinations,
aggregate command delegation and truthful enabled state, in-place one-second
live status refresh, byte-rate formatting, and bounded route-summary expiry,
reset, and redaction. The workspace validation command covers
Rust/TypeScript types, unit and integration tests, formatting, linting,
generated localization types, documentation links, and production build
output.
