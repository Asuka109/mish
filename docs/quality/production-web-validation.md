# Production Web Validation

## Artifact boundary

`apps/web/` is the production React entry for an ordinary browser and the future
desktop WebView. It consumes shared components from `packages/ui/` and CSS
tokens from `packages/design-tokens/`. It does not import source, fixtures, or
runtime assets from `sketch/`.

Ordinary browser startup uses `FixtureStatusClient`, `FixtureProfileClient`, and
`FixtureTrafficClient`, implementations of the independent typed product
boundaries. Status commands update detached in-memory DTO snapshots only;
Traffic is read-only and derives Closed rows locally. Profile mutations,
including local-file preflight, report unsupported instead of simulating
success. The UI identifies this as demo data; no System Proxy, TUN, Mihomo core
operation, probe, capture, WebSocket, filesystem access, or network request is
executed.

`RpcStatusClient`, `RpcProfileClient`, and `RpcTrafficClient` are available only
for explicit composition with an injected `RpcClient`. Runtime schemas reject
malformed results and notifications before they enter product state. The Tauri
WebView composes them from the validated process-only desktop bootstrap. An
ordinary browser has no endpoint or token bootstrap and remains fixture-backed.

English and Simplified Chinese UI dictionaries are bundled with the production
artifact and exposed through generated `typesafe-i18n` functions. Locale changes
use no remote service. User-authored profile, group, node, and service labels
remain opaque strings and are never translated.

## Production routes

The six stable destinations are:

| URL         | Current Part 1 state                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `/status`   | Complete fixture-backed reference surface                               |
| `/routes`   | Nested fixture policy graph; RPC selection remains read-only            |
| `/profiles` | Desktop profile list/import/refresh/inactive-delete operations          |
| `/traffic`  | Read-only Active, bounded local Closed, and ordered Rules investigation |
| `/events`   | Structured event/diagnostic ownership and missing-buffer state          |
| `/settings` | Structured capability/settings ownership and fixture-only state         |

React Router owns these client routes. Development and Vite preview use SPA
fallback behavior. Tauri's embedded-asset resolver also returns the bundled
`index.html` for unknown paths. Any future local HTTP asset host must preserve
that behavior for unknown non-asset paths so a direct URL or browser refresh
resolves before React Router takes over.

## Required commands

Run from the repository root:

```sh
pnpm install
pnpm i18n:generate
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:run
pnpm rust:format:check
pnpm rust:check
pnpm rust:clippy
pnpm rust:test
pnpm build
pnpm design:lint
pnpm docs:links
git diff --check
```

`pnpm validate` runs the repository checks except `git diff --check`, which
remains an explicit Git working-tree check.

## Automated coverage

Automated tests cover:

- direct rendering of all six deep-link routes;
- semantic sidebar links and accessible active destination state;
- typed fixture snapshot isolation and fixture-only capability declarations;
- legacy selector-contract compatibility plus all extended policy-group types;
- nested group graph validation for cycles, missing children, duplicate or
  illegal relationships, and invalid current selections;
- Unicode route search, per-group configuration/latency/label sorting,
  selector-scoped selection, unsupported-group behavior, and RPC read-only
  controls;
- a 160-node scale fixture whose collapsed children are not rendered;
- group-scoped child validation and selection;
- aggregate capture state without real system operations;
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
  paths and credential-bearing input without reflecting sensitive values;
- Profiles UI coverage for fixture isolation, HTTPS and native local preflight,
  preview/save, manual refresh, inactive deletion, and disabled activation and
  active deletion;
- independent Traffic snapshot validation, cancellation, subscription
  reconciliation, stale transport state, and Controller-session reconnects;
- bounded active-to-Closed derivation without reconnect-gap false closure,
  local-only Clear Closed, structured filtering, exact counter sorting, complete
  route-chain detail, fictional privacy fixtures, and incremental large-snapshot
  rendering;
- a real WebSocket client/server flow against the TypeScript mock bridge,
  including authentication, snapshots, subscriptions, commands, core state,
  typed failure, non-mutation after failure, and cleanup; and
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
  network-changing Status command;
- transport-neutral Rust runtime coverage using an injected embedded-core
  adapter, including native snapshot identity, lifecycle events, stable typed
  failures, and suppression of false success events;
- browser startup isolation from desktop IPC, strict loopback endpoint
  validation, and separation of the authentication token from the WebSocket
  URL; and
- desktop token generation plus development/production Origin allowlists.

## Manual browser checks

Before a visible production change is accepted, verify:

- Status at comfortable desktop width and below the Session/Groups stacking
  breakpoint;
- direct load and browser refresh for every route;
- keyboard traversal of navigation, routing, capture, profile, group picker,
  service management, and dialog close/cancel actions;
- visible focus and no clipped focus rings;
- reduced-motion mode, WebGL unavailable fallback, and an inactive aggregate
  control;
- long mixed-script, emoji, and no-emoji labels without semantic parsing;
- Routes search, independent group sorting, nested expansion, read-only control
  descriptions, and the collapsed large-fixture rendering boundary;
- Services at three columns and one column; and
- no browser console errors, unexpected runtime requests, or CDN assets.

## Desktop-bridge replacement gate

The desktop bootstrap now provides an explicit endpoint and ephemeral secret,
while the initial desktop bridge covers loopback binding, strict Host/Origin checks,
authentication, message and subscription bounds, JSON-RPC framing, a sparse
validated Status snapshot, and explicit process lifecycle. Tauri embeds and
serves the offline bundle from its own application protocol; a future same-origin
HTTP host remains a desktop-bridge interface change.

The browser replacement gate remains closed for Controller-backed Status data.
The desktop bridge has a tested read-only Controller-to-Status mapper, and the
shared bootstrap can compose an explicit Controller source, but the Tauri shell
does not configure one until core and profile activation exist. The Profile
slice is separately composed through authenticated RPC and a capability-gated
native file picker. A fixture or mock interaction must never be relabeled as a
successful system, filesystem, or network action.
