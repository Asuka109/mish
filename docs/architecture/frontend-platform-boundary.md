# Frontend and Platform Boundary

The production dependency direction is deliberately one way:

```text
contracts -> transport/session -> XState actors -> Query projections -> React UI
                                      ^                         ^
                                      |                         |
                              Electron/RN host seams       Store presentation
```

## Web product

`apps/web/src/main.tsx` composes the authenticated Web session. The shared
`OrpcSessionAuthority` owns the WebSocket session and ordered transcript
delivery. `rpcSessionMachine` and domain actors own lifecycle transitions.
`CutoverViewProvider` requests typed projections through TanStack Query. Pages
may own filters, tabs, disclosure, and other local presentation state, but may
not create a second session or cache authority.

The six routes are `/status`, `/routes`, `/profiles`, `/traffic`, `/events`,
and `/settings`. They consume only the typed operations declared in
`packages/contracts/src/orpc.ts`.

## Electron seam

`apps/desktop/src` is a thin Electron host. Main-process code owns window
creation and safe preload exposure; it does not own product state, session
generations, cache invalidation, or service lifecycle. The renderer consumes
the same Web composition. Host tests inspect the real source graph and assert
that retired native paths, old wire labels, and POC imports are absent.

## React Native seam

`apps/mobile/src` is a thin React Native host. It may expose the minimum
platform effect seam required by the host, but product lifecycle, session
authority, and data projections remain shared TypeScript contracts and actors.
The Android project is admitted through the dual-ABI debug build and root-free
emulator replay gate. No native layer is allowed to become a product fallback
or to duplicate the Web lifecycle.

## Forbidden edges

Production code must not import `poc/`, retired package names, retired native
paths, or a compatibility bridge. A page must not call an operating-system
effect directly. A host must not emulate an old client API when a contract or
actor is absent; the correct response is a typed unavailable/error projection.

## Evidence boundary

The graph checker follows the actual production entries and resolves TypeScript
aliases and extensionless imports. Tests may contain negative assertions for
retired markers; those tests are not production entries. Transcript fixtures
and replay prove bounded ordering/privacy behavior only, not real permissions,
network, VPN, TUN, or system effects.
