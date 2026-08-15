# Mish Desktop Electron host

This package is the production Electron host for the shared Mish web
composition. The host is ESM-only and uses Electron `43.4.0` with a
`sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`
renderer. Preload exposes only the typed `window.mishElectron` surface.

```sh
pnpm --filter @mish/desktop typecheck
pnpm --filter @mish/desktop build
pnpm --filter @mish/desktop test:run
pnpm --filter @mish/desktop fixture:build
```

The main process owns the authenticated oRPC MessagePort session. The token
never crosses the contextBridge, and the renderer receives neither Electron,
Node, IPC, MessagePort, nor transport primitives. Each renderer lifetime gets
one fresh session authority; React StrictMode cleanup is bounded and cannot
reuse a disposed actor.

Host and renderer effects emit only bounded semantic transcript records with
synthetic correlation IDs. Transcript replay and deterministic tests are
automated evidence; an optional isolated macOS DMG fixture is separate real
Electron evidence. Fixtures are credential-free and do not start networking,
VPN/TUN/Core, system proxy, privileged settings, signing, notarization, or
publishing. Timed-out fixture processes are terminated only after PID/group
ownership is established and are verified to leave no process or mount behind.

The existing native source tree remains outside this packet and is not a
runtime dependency of the Electron host.
