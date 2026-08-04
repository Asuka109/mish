# Mobile Native Shell Entry Contract

## Delivery status

The Shared Rust contract is implemented in
[`crates/mobile-shell`](../../crates/mobile-shell) as a production-disabled
vertical slice. It is a workspace crate but is not a dependency of
[`apps/mobile`](../../apps/mobile), so the current React `MobileShell` remains
selected. This delivery adds no UI or runtime dependency and changes no
Desktop WebView or Browser Client route, history, presentation, or command.

The contract is the accepted boundary from Issue #343 and PR #370:

```text
Android/Apple native chrome or platform deep link
  -> Shared Rust outer-shell authority
  -> one accepted webEntryPath directive
  -> React Router
```

There is no reverse shell or Native-UI channel. Existing separately audited
Shared Rust product commands are not shell inputs and must never become a
generic Native-UI escape hatch.

## Exact ownership

| Owner                    | Owns                                                                                                                                                     | Must not own                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Shared Rust mobile shell | Process authority ID, selected top-level destination, last accepted Web entry, monotonic revision, bounded retired intent IDs, prepare/commit admission  | Product route catalog, per-tab stack, internal history/back, `canGoBack`, page or sheet state, DOM focus, haptics, permissions |
| Android host adapter     | Material tab/drawer input, `onNewIntent` platform URL facts, Activity/WebView attachment, accepted native snapshot rendering, one-way directive delivery | Arbitrary product paths from chrome, selected state before Rust commits, a route stack, Web-originated shell commands          |
| Apple host adapter       | System tab/sidebar input, scene/open-URL facts, controller/WKWebView attachment, accepted native snapshot rendering, one-way directive delivery          | Multiple product WebViews, an internal product navigation stack, script-message or URL-command handlers                        |
| React Router/Web         | Product routes, redirects, child routes, query state, internal history/back, page and business sheets, `canGoBack`, route focus and DOM focus            | Native tab/drawer selection, native sheet/haptic/permission requests, shell acknowledgement or path mirroring                  |

The Rust destination enum is closed to Home, Routes, Profiles, Activity, and
Settings. Android and Apple chrome constructors accept only one enum value and
therefore cannot carry an arbitrary path. Their accepted roots are `/status`,
`/routes`, `/profiles`, `/traffic`, and `/settings`.

A platform deep link is different. The operating-system adapter first verifies
its platform scheme, host/application identity, and caller context, then gives
Rust only the root-relative `path?query`. Rust creates `WebEntryPath` only when
the value:

- is at most 2,048 UTF-8 bytes and starts with exactly one `/`;
- has no authority, fragment, backslash, control/whitespace, invalid percent
  encoding, encoded path delimiter, or dot segment; and
- maps by its first literal segment to one declared top-level destination.

This validation establishes a safe same-application Web entry and its shell
projection; it does not enumerate or own React Router child routes. The exact
validated text, including its query, is preserved in the directive. React
Router remains responsible for matching, redirecting, or showing Not Found.

## State and transition model

`ShellSnapshot` contains only:

```text
authorityId + revision + selectedDestination + webEntryPath
```

`webEntryPath` is the last outer-shell entry, not a mirror of the current Web
location. Web navigation never writes it. `WebEntryDirective` carries the same
authority ID, committed revision, and entry path toward one WebView.

An intent has a bounded log-safe ID, an expected revision, and exactly one of:

```text
androidChrome(destination)
appleChrome(destination)
platformDeepLink(validatedWebEntry)
```

There is no Web/React source, generic path action for chrome, Back action,
focus token, sheet action, haptic action, permission action, or callback.

Every transition uses two checks:

1. `prepare` performs side-effect-free identifier, duplicate, expected-revision,
   source-shape, and entry validation and freezes a proposed transition.
2. `commit` repeats authority, duplicate, and expected-revision checks at the
   actual mutation boundary. A transition prepared before another commit is
   rejected as stale and cannot win later.

Only `Applied` increments revision, changes the snapshot, retires the intent ID,
and emits a directive. `Duplicate`, `RejectedStale`, `RejectedAuthority`, and
`RejectedRevisionExhausted` return the current snapshot, emit no directive, and
make no mutation. Revision uses checked `u64` addition and fails closed at its
limit.

The authority retains at most 128 committed intent IDs. A retained replay is
`Duplicate`. After eviction, its old expected revision remains stale because
revisions never decrease. This keeps memory bounded without allowing an old
intent to become current again.

## Android adapter seam

The future Android cutover adapter must:

1. obtain one process-scoped `MobileShellAuthority` from Rust application state;
2. render tab/drawer selection only from a returned `ShellSnapshot`;
3. create `androidChrome(destination)` from Material chrome, never from Web;
4. validate the Android intent's application scheme/host and pass only its
   root-relative entry to `WebEntryPath::parse`;
5. submit the prepared transition and consume only an `Applied` directive;
6. deliver that directive toward the attached Tauri WebView once per
   `(authorityId, revision, WebView instance)`; and
7. refresh the complete snapshot after stale, duplicate, interrupted, or
   otherwise unknown transport outcomes instead of guessing selection.

The adapter may use a bounded JNI/FFI wrapper consistent with the existing
mobile native pattern. It must not install `addJavascriptInterface`, an Android
Web message listener, a custom URL command scheme, or a Web-facing Tauri shell
command/event listener. Native pressed/ripple and predictive-back progress stay
local presentation facts; they do not commit selected state.

## Apple adapter seam

The future Apple host adapter must:

1. keep one process-scoped Rust authority and exactly one Tauri `WKWebView`;
2. create `appleChrome(destination)` only from system tab/sidebar chrome;
3. validate scene/open-URL application identity before Rust validates the
   root-relative Web entry;
4. render selected system chrome only from the accepted snapshot;
5. deliver an `Applied` directive toward the same WKWebView once per authority,
   revision, and WebView instance; and
6. reconcile a full snapshot after stale, duplicate, interrupted, or unknown
   outcomes.

It must not install `WKScriptMessageHandler`, `WKURLSchemeHandler`, a custom URL
command channel, or a Web-facing Tauri shell command/event listener. UIKit or
SwiftUI may own the platform container and native-origin platform sheets, but
neither may create a product route stack or accept a Web request for Native UI.

## Lifecycle and recovery

The authority is process-scoped and begins at Home revision 0 with `/status`.
A newly attached WebView receives that snapshot's entry once for its own
instance. Activity, scene, controller, or WebView recreation reads the complete
snapshot; it does not reconstruct selection from a Web URL. Reattaching a new
WebView may deliver the last accepted entry once to that new instance, while an
already attached WebView never receives a duplicate or stale directive.

An accepted platform deep link updates the matching top-level selection and
preserves its complete validated entry in one commit. Later Web child
navigation, Back, sheet changes, query changes, and focus changes never report
back. Process replacement creates a new authority ID; adapters discard prior
prepared intents, revisions, snapshots, and delivery-dedupe records.

Invalid identifiers or entries fail during side-effect-free construction and
leave the authority unchanged. A stale prepared transition, retained duplicate,
foreign-authority preparation, or revision overflow also leaves it unchanged.
There is no cancellation cleanup phase because the reducer owns no external
resource or asynchronous effect. Future adapters remain responsible for
cleaning up their own temporary platform work before publishing a terminal
outcome; an early validation error must not skip that cleanup.

## Boundary enforcement and evidence

[`scripts/check-mobile-shell-boundary.ts`](../../scripts/check-mobile-shell-boundary.ts)
scans mobile host, shared Web, Apple prototype, and Rust shell sources. It fails
on Android JavaScript interfaces/Web message listeners, Apple script/custom
scheme handlers, Web-facing Tauri shell commands, Web-emitted Native-UI events,
custom URL command channels, and equivalent named shell backchannels. It also
proves the contract crate remains absent from the selected mobile app and has no
runtime dependency.

The companion deterministic tests inject one forbidden fixture for every rule
and a permitted Native-to-Rust-to-Web seam. The platform-neutral JSON fixture
at
[`native-to-web-entry.json`](../../crates/mobile-shell/tests/fixtures/native-to-web-entry.json)
traces Android chrome, a full platform deep link, and Apple chrome through Rust
to exact Web directives.

The Rust model tests cover every source/destination pair, exact deep-link
preservation, invalid-entry non-mutation, monotonic revision over 512 commits,
bounded retirement, duplicate/stale idempotency, prepare/commit TOCTOU races,
cross-authority rejection, bounded identifiers, and revision exhaustion. These
are model and boundary evidence only; they do not claim Android/Apple adapter,
rendering, device, accessibility, bridge-latency, or production-cutover proof.
