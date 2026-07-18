# Production Web Validation

## Artifact boundary

`apps/web/` is the production React entry for an ordinary browser and the future
desktop WebView. It consumes shared components from `packages/ui/` and CSS
tokens from `packages/design-tokens/`. It does not import source, fixtures, or
runtime assets from `sketch/`.

The default app uses `FixtureStatusClient`, an implementation of the shared
typed `StatusClient` boundary. Its commands update detached in-memory DTO
snapshots only. The toolbar and aggregate capture action identify this as demo
data; no System Proxy, TUN, Mihomo core operation, probe, capture, WebSocket, or
network request is executed.

`RpcStatusClient` is available only for explicit composition with an injected
`RpcClient`. Runtime schemas reject malformed results and notifications before
they enter product state. No endpoint, authentication token, or browser
transport factory is wired into default application startup.

English and Simplified Chinese UI dictionaries are bundled with the production
artifact and exposed through generated `typesafe-i18n` functions. Locale changes
use no remote service. User-authored profile, group, node, and service labels
remain opaque strings and are never translated.

## Production routes

The six stable destinations are:

| URL         | Current Part 1 state                                            |
| ----------- | --------------------------------------------------------------- |
| `/status`   | Complete fixture-backed reference surface                       |
| `/routes`   | Structured policy-group ownership and missing-agent state       |
| `/profiles` | Structured profile-lifecycle ownership and missing-store state  |
| `/traffic`  | Structured connections/rules ownership and missing-stream state |
| `/events`   | Structured event/diagnostic ownership and missing-buffer state  |
| `/settings` | Structured capability/settings ownership and fixture-only state |

React Router owns these client routes. Development and Vite preview use SPA
fallback behavior. Any future static server or local agent must return the same
bundled `index.html` for an unknown non-asset path so a direct URL or browser
refresh resolves before React Router takes over.

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
- pending command deduplication plus suppression of success UI after failure.
- a real WebSocket client/server flow against the TypeScript mock agent,
  including authentication, snapshots, subscriptions, commands, core state,
  typed failure, non-mutation after failure, and cleanup; and
- Rust local-agent integration coverage for malformed and unauthenticated RPC,
  contract-compatible Status snapshots, subscription snapshot ordering, hostile
  Origin rejection, loopback-only binding, explicit sidecar start/stop,
  independent child exit publication, version reporting, and child cleanup.
- transport-neutral Rust runtime coverage using an injected embedded-core
  adapter, including native snapshot identity, lifecycle events, stable typed
  failures, and suppression of false success events.

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
- Services at three columns and one column; and
- no browser console errors, unexpected runtime requests, or CDN assets.

## Local-agent replacement gate

The validated DTO/RPC client boundary, reconnect behavior, pending and typed
failure semantics, and fake-transport integration coverage now exist. Replacing
the startup fixture still requires the local agent to implement and test strict
Host/Origin checks, loopback binding, authentication-secret bootstrap, message
and subscription limits, matching schemas, and real command reconciliation.
The initial agent now covers loopback binding, strict Host/Origin checks,
authentication, message and subscription bounds, JSON-RPC framing, a sparse
validated Status snapshot, and explicit process lifecycle. The replacement gate
remains closed until the agent serves the offline bundle from its origin,
bootstraps the browser endpoint and secret, reconciles state against the pinned
Mihomo controller API, and implements the required commands. A fixture or mock
interaction must never be relabeled as a successful system or network action.
