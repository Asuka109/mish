# Production Web Validation

## Artifact boundary

`apps/web/` is the production React entry for an ordinary browser and the future
desktop WebView. It consumes shared components from `packages/ui/` and CSS
tokens from `packages/design-tokens/`. Production startup cannot select the demo
fixture adapters or import demo-only runtime assets.

Browser startup always attempts the same-origin desktop bootstrap. A valid
HttpOnly session and origin-scoped proof compose the RPC adapters immediately;
an unauthenticated browser renders the PIN pairing page and never mounts product
providers or fixture data. Fixture adapters remain available to unit, browser,
and acceptance harnesses, but production startup cannot select them.

`RpcStatusClient`, `RpcProfileClient`, and `RpcTrafficClient` are available only
for explicit composition with an injected `RpcClient`. Runtime schemas reject
malformed results and notifications before they enter product state. The Tauri
WebView composes them from the validated process-only desktop bootstrap. A
browser explicitly launched by the desktop status-bar menu composes the same
clients after exchanging a high-entropy one-time same-origin launch token from the
URL fragment. A direct bridge URL instead requests a six-digit PIN from the
desktop app and exchanges it for a random browser session.

English and Simplified Chinese UI dictionaries are bundled with the production
artifact and exposed through generated `typesafe-i18n` functions. Locale changes
use no remote service. User-authored profile, group, node, and service labels
remain opaque strings and are never translated.

## Production routes

The six stable destinations are:

| URL         | Current Part 1 state                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `/status`   | Authenticated desktop runtime status                                    |
| `/routes`   | Authenticated policy graph and RPC selection                            |
| `/profiles` | Desktop profile lifecycle and transactional managed activation          |
| `/traffic`  | Read-only Active, bounded local Closed, and ordered Rules investigation |
| `/events`   | Structured event/diagnostic ownership and missing-buffer state          |
| `/settings` | Structured authenticated capability and settings ownership              |

React Router owns these client routes. Development and Vite preview use SPA
fallback behavior. Tauri's embedded-asset resolver also returns the bundled
`index.html` for unknown paths. The local browser host preserves that behavior
for unknown non-asset paths while returning `404` for missing asset filenames,
so a direct URL or browser refresh resolves before React Router takes over.
The Browser Client consumes a valid one-time launch fragment before React Router
mounts, whether the requested path is the root, one of these six destinations,
the legacy `/activity` redirect, or a recognized Routes group path. It replaces
the current history entry without the fragment and keeps the requested path and
query; unknown paths and malformed launch fragments cannot authenticate through
that capability and are scrubbed before the existing session or pairing path.
The source-development console uses the same route-independent client handoff
with a process-lifetime launch capability, allowing its single printed URL to
open multiple clean browser contexts. Production status-bar capabilities remain
bounded, two-minute, and one-time; a new development process invalidates its
predecessor's console URL.

The application shell, platform bootstrap, first-frame reveal handshake, and
default `/status` route remain in the eager entry path. The other route pages
load as coarse page-level chunks inside the already-rendered shell. Vite's
production build table and the existing 700 kB per-chunk warning provide a
visible bundle-size report and advisory; bundle size is not a blocking quality
gate for rapid preview development.

## Required commands

Run from the repository root:

```sh
pnpm install
pnpm generate:i18n
pnpm check:lint
pnpm check:format
pnpm check:types
pnpm test:unit
pnpm test:browser:install
pnpm test:application:simulated-host
pnpm test:browser
pnpm check:rust:format
pnpm check:rust
pnpm check:rust:clippy
pnpm test:rust
pnpm web:build
pnpm check:design
pnpm check:docs
git diff --check
```

`pnpm check:pr` is the rapid pull-request gate. It keeps Android project and
workflow contracts, generated i18n, lint, formatting, TypeScript type checks and
unit tests, Rust formatting, portable workspace/all-target Clippy, the bounded
Rust-authoritative simulated application command, design tokens, and
documentation links blocking. The PR contract excludes only the Desktop,
Mobile, and mobile Tauri plugin application crates whose Linux builds require
host WebKit/GTK libraries; the macOS main inspection retains them. Agents can
reproduce the complete inspection warning contract with one command:
`pnpm check:rust:clippy`; Cargo identifies the owning crate and target in
failure output. The gate intentionally excludes Rust test execution beyond the
simulated application contract, production builds, Design.md lint, and the broad
responsive browser suite.

`pnpm check:all` runs the complete non-browser repository checks for local work
and main-branch inspection. Browser installation, the browser suite, and
`git diff --check` remain explicit checks.

`pnpm test:browser:install` installs the Chromium version pinned by Playwright
and is required once per developer machine or CI image. `pnpm test:browser`
runs the responsive shell suite plus the simulated-host application journey in
Vitest Browser Mode against the real browser layout engine. The focused
`pnpm test:application:simulated-host` command first runs the Rust model/RPC
suite and then that browser journey.

## CI execution tiers

Mish separates merge latency from broad regression detection during rapid
preview development:

- pull requests install pinned Chromium and run `pnpm check:pr`, including the
  portable workspace/all-target Rust Clippy contract, on an isolated
  GitHub-hosted Ubuntu runner with a ten-minute job ceiling; they never install
  host WebKit/GTK application-build dependencies or require root, WebDriver,
  Tart, a real Core/Helper/TUN, signing, publication, physical devices,
  host-network mutation, or application package upload;
- every push to `main` independently builds the macOS ARM64 and Android test
  packages but does not repeat the complete validation suite;
- a daily scheduled inspection at 03:23 UTC, plus manual dispatch, checks out
  the latest `main` and runs `pnpm check:all` plus the real-browser suite on
  macOS; and
- manual dispatch can select `packages` or `all` to recover package production
  against the latest `main` when an automated merge credential does not emit a
  follow-up push workflow.

The pnpm store is keyed by `pnpm-lock.yaml`. Rust inspection and package jobs use
job-specific dependency/build caches instead of uploading the entire Cargo
target directory through a generic immutable cache. Android packaging also
caches Gradle dependencies from the wrapper and build-script inputs. Scheduled
inspection failures are regression signals on `main`; they do not retroactively
claim that a prior pull request received the heavy suite.

## Automated coverage

Automated tests cover:

- direct rendering of all six deep-link routes;
- an eager application shell and default Status route while secondary route
  pages remain page-level deferred boundaries;
- real-browser responsive layout at 320 x 568, 390 x 844, and the Tauri minimum
  of 800 x 600, in English and Simplified Chinese, including document/page
  overflow, navigation labels, viewport-clipped controls, completed deferred
  route loading, and table-local horizontal scrolling;
- semantic sidebar links and accessible active destination state;
- real Chromium focus geometry across browser, desktop-WebView, and mobile
  compositions in both appearances and locales: only Tab or Shift+Tab marks a
  visible actionable target, pointer/touch and imperative focus stay silent,
  hidden/disabled/inert targets are rejected, and Base UI trap/return behavior
  remains intact;
- typed fixture snapshot isolation and fixture-only capability declarations;
- legacy selector-contract compatibility plus all extended policy-group types;
- nested group graph validation for cycles, missing children, duplicate or
  illegal relationships, and invalid current selections;
- Unicode route search, per-group configuration/latency/label sorting,
  selector-scoped selection, unsupported-group behavior, and RPC read-only
  controls;
- a 160-node scale fixture whose collapsed children are not rendered;
- group-scoped child validation and selection;
- aggregate capture state, default-off fixture behavior, and explicit fixture-only
  descriptions without real system operations;
- routing-mode changes through Base UI pressed-state controls;
- verbatim mixed-script and emoji labels; and
- English-to-Chinese switching, document language updates, and local locale
  persistence;
- authentication-first request flow and typed result validation;
- malformed payloads, unknown or mismatched IDs, typed remote errors, and
  message-size limits;
- validated subscriptions, disconnect/reconnect state, bounded retry,
  cancellation, disposal, and cleanup;
- an end-to-end fake-transport Status adapter flow across snapshots,
  subscriptions, commands, reconnect without a follow-up event, and typed
  failure; and
- pending command deduplication plus suppression of success UI after failure;
- profile service preflight/save/refresh/delete behavior, last-known-valid
  retention after a failed refresh, and display-view redaction;
- authenticated Profile RPC coverage, including rejection of arbitrary local
  paths, raw patch payloads, and credential-bearing input without reflecting
  sensitive values;
- Profiles UI coverage for fixture isolation, HTTPS and native local preflight,
  preview/save, structured patch drafts and unsaved-change protection, manual
  refresh, activation/cancellation, inactive deletion, and guarded active
  deletion through replacement or explicit safe stop;
- Profile patch coverage for deterministic rule/group ordering, semantic
  conflict detection, revision binding, persistence round trips, refresh-stale
  last-known-valid behavior, redaction, and shared preview/activation generation;
- Profile RPC activation coverage for repository artifact revalidation,
  deduplication, cancellation, rollback, redaction, missing managed binaries,
  atomic Status/Traffic profile replacement, and authoritative reconnect;
- independent Traffic snapshot validation, cancellation, subscription
  reconciliation, stale transport state, and Controller-session reconnects;
- bounded active-to-Closed derivation without reconnect-gap false closure,
  local-only Clear Closed, structured filtering, exact counter sorting, complete
  route-chain detail, fictional privacy fixtures, and incremental large-snapshot
  rendering;
- a real WebSocket client/server flow against the transport-only TypeScript mock
  bridge, including Host/Origin admission, authentication, static snapshots,
  subscriptions, schema and cancellation framing, explicit lifecycle-command
  failure, injected typed failure, and cleanup; and
- the bounded Rust-authoritative simulated-host application command, including
  deterministic logical time, authenticated RPC/client contracts, semantic
  notifications, React pending/terminal interaction, stale/equal/duplicate,
  reconnect/remount, cancellation/replacement, and sanitized failure evidence;
- Rust desktop-bridge integration coverage for malformed and unauthenticated RPC,
  contract-compatible Status snapshots, subscription snapshot ordering, hostile
  Origin rejection, loopback-only binding, explicit managed-process start/stop,
  independent child exit publication, version reporting, and child cleanup.
- synthetic Controller-to-Status mapping coverage for nested groups,
  group-scoped and invalid selections, long mixed-script labels,
  profile-scoped identifiers, exact proxy metadata and latency, stale and empty
  streams, bounded traffic retention, bounded connection de-duplication, and
  effective-rule counts;
- explicit desktop-bridge rejection and non-mutation coverage for every
  unsupported network-changing Status command;
- authenticated Capture RPC coverage for confirmed System Proxy application,
  typed TUN rejection without a valid backend, paired Browser/WebView TUN
  capability and Helper lifecycle parity, shared pending and terminal operation
  identity across simultaneous clients, cancellation/disconnect read-back,
  reconnect, drift notifications, bounded recovery actions, and sensitive-state
  redaction;
- transport-neutral System Proxy reconciliation coverage for pending/applied/
  failed/drift state, external modification, partial failure, confirmed
  rollback, rollback failure, network-service changes, core crash, restart
  audit, conservative shutdown, unavailable capability, and repair or
  leave-as-is recovery;
- macOS adapter coverage for structured fixed-program arguments, current-service
  observation, exact blank and populated disabled HTTP/HTTPS/SOCKS fields, safe
  value-before-state restoration, PAC URL and automatic-discovery preservation,
  conservative missing-field rejection, permission failure typing, private
  atomic journaling, and output redaction;
- transport-neutral Rust runtime coverage using an injected embedded-core
  adapter, including native snapshot identity, lifecycle events, stable typed
  failures, and suppression of false success events;
- standalone browser isolation from desktop IPC, explicit bridge-launched
  browser composition, one-time launch-token consumption, bounded manual PIN
  exchange, strict Host/Origin and loopback endpoint validation, HttpOnly
  refresh-session plus origin-proof recovery, and separation of both launch
  material and the RPC authentication token from the WebSocket URL;
- desktop token generation plus development/production Origin allowlists; and
- the complete macOS P0 fixture journey across local and HTTPS import,
  validation, activation, Rule/Global/Direct confirmation, System Proxy,
  Status/Routes/Traffic/Events observation, restart, failed activation rollback,
  drift repair, and safe stop.

The installed-app steps and P0 blockers for that journey are defined in
[`macos-p0-acceptance.md`](macos-p0-acceptance.md).

## Manual browser checks

Before a visible production change is accepted, verify:

- Status at comfortable desktop width and below the Session/Groups stacking
  breakpoint;
- direct load and browser refresh for every route;
- keyboard traversal of navigation, routing, capture, profile, group picker,
  service management, and dialog close/cancel actions;
- visible focus and no clipped focus rings after Tab or Shift+Tab, with no ring
  after pointer/touch activation, route-title announcements, reconnect, Profile
  changes, notification actions, or overlay initial/return focus;
- reduced-motion mode, WebGL unavailable fallback, and an inactive aggregate
  control;
- long mixed-script, emoji, and no-emoji labels without semantic parsing;
- Routes search, independent group sorting, nested expansion, read-only control
  descriptions, and the collapsed large-fixture rendering boundary;
- Services at three columns and one column; and
- no browser console errors, unexpected runtime requests, or CDN assets.

For a real-client check, launch the desktop shell, choose `Open Browser Client`
from the status-bar menu, and confirm that Status reports RPC-backed state, a
refresh of every deep route remains authenticated, and native-only actions such
as local-file import, backup/restore, support-bundle export, and Sidebar material
remain unavailable. On a host with a valid development TUN backend, confirm that
Virtual Interface and Helper install, repair, and removal availability match the
Desktop WebView, while every pending, recovery-required, failure, and terminal
result comes from the same Rust operation rather than optimistic browser state.
Then open the bridge root directly, confirm that no product
or demo state appears before authentication, enter the six-digit PIN shown by
the desktop app, and confirm that the browser session survives a refresh.
The explicit source-only `pnpm demo` and `pnpm desktop:demo` targets are outside
this authentication check; ordinary development and production modes must never
infer demo mode from a missing or failed backend.

### Browser backend-disconnection recovery

1. Start Mish, open the Browser Client from the status-bar menu, authenticate,
   and leave a non-default route loaded in the browser tab.
2. Quit Mish while keeping that tab open. After the bounded WebSocket reconnect
   attempts finish, confirm that the complete application shell is replaced by
   the disconnected surface, the prior controls cannot be focused or invoked,
   and the editable backend port initially matches the tab's original Mish
   origin.
3. Enter a known Mish backend port, select **Connect**, and confirm that only
   the entered port is checked and targeted without requests to any other port.
   With Mish stopped, confirm that Connect reports its exact-port failure on the
   recovery surface instead of navigating to a browser error page. Also confirm
   that an empty or out-of-range manual value leaves the field editable with
   inline validation and disables Connect without disabling Scan.
4. Start Mish again on a later allowed port, select **Scan**, and confirm that
   the browser starts at port 6474, skips unrelated listeners, writes the first
   valid Mish port into the visible field, and then enters the same Connect
   path. Confirm that an empty-port scan stops after five candidates, an
   occupied-port scan stops after at most 10 non-Mish listeners, the current
   path and query are preserved, and replacement navigation does not carry the
   old fragment.
5. Complete the existing six-digit pairing flow when requested. Confirm that no
   prior process session or proof bypasses authentication and that the restored
   route is backed by live RPC state.
6. Also confirm that stopping or restarting the bridge does not replace the
   desktop WebView or mobile shell with the Browser Client recovery surface.

## Desktop-bridge replacement gate

The desktop bootstrap now provides an explicit endpoint and ephemeral secret,
while the desktop bridge covers loopback binding, strict Host/Origin checks,
authentication, message and subscription bounds, JSON-RPC framing, a sparse
validated Status snapshot, and explicit process lifecycle. Tauri embeds the
offline bundle for its application protocol, and the bridge serves that same
resolver-backed artifact from its authenticated browser-client origin.

The desktop gate is open for Controller-backed Status and Traffic only after a
repository-owned profile completes managed activation. Tauri starts safely
stopped, uses an app-data-private runtime root and the managed pinned binary
resolver, and replaces the runtime only after version, readiness, first valid
Status/Traffic observations, and active-state commit. The Profile slice is
composed through authenticated RPC and a capability-gated native file picker.
A missing binary remains unavailable, and a fixture or mock interaction must
never be relabeled as a successful system, filesystem, or network action.
