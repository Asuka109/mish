# Production Web Validation

The Web gate validates the final renderer graph rather than an old host
adapter. `scripts/check-production-retirement.ts` starts at the Web, Electron,
and RN production entries, resolves TypeScript aliases, and fails on missing
imports, POC edges, retired paths, old protocol labels, or duplicate session
authority markers.

## Renderer evidence

`apps/web/src/pages/cutover-pages.test.tsx` replays typed projections for all
six destinations: Status, Routes, Profiles, Traffic, Events, and Settings.
The test asserts navigation and product-specific content. The session actor
tests cover connect/dispose, ordered delivery, failure, and reconnect display.
Query data is supplied through the shared view facade; no page creates a
compatibility client.

Run:

```sh
pnpm --filter @mish/web typecheck
pnpm --filter @mish/web test:run
pnpm web:build
pnpm check:graph
```

These checks prove contract rendering, graph shape, and replay behavior. They
do not prove an external network, permission grant, VPN/TUN attachment, or
system setting mutation.
