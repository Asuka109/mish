# Production Web Validation

## Artifact boundary

`apps/web/` is the production React entry for an ordinary browser and the future
desktop WebView. It consumes shared components from `packages/ui/` and CSS
tokens from `packages/design-tokens/`. It does not import source, fixtures, or
runtime assets from `sketch/`.

Part 1 uses `FixtureStatusClient`, an implementation of the typed `StatusClient`
boundary. Its commands update detached in-memory DTO snapshots only. The
toolbar and aggregate capture action identify this as demo data; no System
Proxy, TUN, Mihomo, probe, capture, or network request is executed.

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
pnpm build
pnpm design:lint
pnpm docs:links
git diff --check
```

`pnpm validate` runs the repository checks except `git diff --check`, which
remains an explicit Git working-tree check.

## Automated coverage

Part 1 tests cover:

- direct rendering of all six deep-link routes;
- semantic sidebar links and accessible active destination state;
- typed fixture snapshot isolation and fixture-only capability declarations;
- group-scoped child validation and selection;
- aggregate capture state without real system operations;
- routing-mode changes through Base UI pressed-state controls;
- verbatim mixed-script and emoji labels; and
- English-to-Chinese switching, document language updates, and local locale
  persistence.

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

## Part 2 replacement gate

Part 2 may replace `FixtureStatusClient` with a validated DTO/RPC client without
changing the view component contract. Before that adapter is considered real,
it must add pending and typed failure semantics, authenticated same-origin RPC,
stream reconnection, schema validation, and integration tests against the local
agent. A fixture interaction must never be relabeled as a successful system or
network action.
