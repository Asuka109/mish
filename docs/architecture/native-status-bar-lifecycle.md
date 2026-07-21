# Native status bar and window lifecycle

## Decision

On macOS, Mish installs one Tauri status-bar icon and keeps the desktop bridge,
runtime host, profile activation coordinator, capture audit loop, and managed
core alive when the main window is hidden. The menu is a native projection of
the same `DesktopRuntimeHost` and `ProfileActivationCoordinator` used by the
authenticated Web RPC surface. It does not own a second application-state
store.

The menu subscribes to runtime replacement, core/status updates, capture
reconciliation updates, and profile activation updates. It rebuilds native menu
items from the latest typed native Status snapshot after each update and after
each native command. Pending, failed, drifted, and unavailable states are
worded explicitly; a failed operation is never converted into a local success.

## Menu surface

The implemented compact surface contains:

- open Mish and open the Routes destination in the existing WebView;
- current profile state, with a bounded display-safe label when that label does
  not resemble a URL, path, endpoint, or credential;
- confirmed System Proxy state, enable/disable, repair, and leave-as-is recovery
  commands;
- confirmed TUN state and enable/disable commands when the helper is healthy,
  with pending, failed, and drift states remaining non-active;
- routing-mode selection when the active Controller source advertises the
  command;
- transactional Core restart or recovery through the active or last attempted
  profile; and
- quit.

`Open Browser Client` creates a fresh high-entropy one-time launch PIN and opens
the desktop bridge's bundled-asset origin in the default browser. The PIN is not
the RPC credential, is consumed by an Origin-validated bootstrap request, and
is carried in the URL fragment and removed from the address bar immediately. A
scoped HttpOnly session plus an origin-scoped browser proof permits refresh
without persisting the RPC credential. Full policy-group child selection
is not duplicated in the native menu in this slice. `Open Routes` remains the
native progressive-disclosure path.

Successful launch is visible as the newly opened browser window. CSPRNG, launch
state, invalid-URL, or operating-system open failures display a native warning
dialog with an accessible message and safe retry instruction; they do not
silently leave a dead menu command or expose a credential for manual recovery.

The menu never includes node labels, node identifiers, service URLs,
authentication tokens, filesystem paths, controller addresses, RPC endpoints,
or private runtime details. Native navigation accepts only a fixed set of
product destinations.

## Window lifecycle

`windowCloseBehavior` is a durable application preference independent from
`launchAtLogin` and `loginLaunchBehavior`:

- `hide-to-status-bar` is the safe default. A close request is prevented and the
  existing main window is hidden. The WebView is not the owner of the runtime,
  bridge, capture reconciler, or status menu.
- `quit` exits the Tauri event loop. Ordered bridge shutdown then cancels active
  profile work, stops capture auditing, conservatively restores confirmed
  Mish-owned System Proxy state, stops the managed core, and closes RPC.

Login launch behavior still applies only to launches carrying the fixed login
startup argument. A manual launch shows the window regardless of that setting.
The shell now defers that initial reveal until the WebView has validated desktop
bootstrap and React has committed its first tree. A bounded `reveal_main_window`
command applies the previously computed login-launch policy, so the WebView
cannot promote a background login launch into a visible window.
Opening Mish or Routes from the status bar shows, unminimizes, and focuses the
existing window.

The native shell persists only the main window's size, valid on-screen position,
and maximized state. It does not persist visibility or fullscreen state. This
keeps multi-monitor restoration bounded to a currently available display and
prevents a prior hide-to-status-bar action from making the next manual launch
invisible. A Dock reopen with no visible windows reveals, unminimizes, and
focuses that same main window.

Tauri's standard macOS application menu retains native About, Services, edit,
window, fullscreen, hide, close, and quit behavior. Mish inserts Settings with
Command-, and Find with Command-F. Settings routes to the fixed Settings
destination; Find focuses only a page control explicitly marked as the native
search target. Web fallback handling accepts Command shortcuts on macOS and
does not reinterpret Control-F or Control-, as their Command equivalents.

After a route change, the WebView moves programmatic focus to the page heading
without scrolling and updates the document title. This gives VoiceOver a stable
announcement target while keeping pointer and keyboard navigation on the same
React route tree.

Unsupported platforms and the browser fixture advertise both status-bar and
window-lifecycle capabilities as unavailable and cannot report native-operation
success.

## Verification

Deterministic tests cover settings migration and persistence, independence from
login launch behavior, authenticated bounded RPC, browser capability fallback,
fixed native navigation destinations, sensitive-label redaction, explicit
System Proxy and TUN phase wording, observation-backed TUN checked state, and
the default hide-versus-quit decision. The workspace validation command covers
Rust/TypeScript types, unit and integration tests, formatting, linting,
generated localization types, documentation links, and production build
output.
