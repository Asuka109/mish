# oRPC policy/transport admission POC

This package is a contract-first, local-only admission POC built against the
repository-pinned oRPC `1.15.0` packages. `src/contract.ts` is the only source
of procedure paths and payload shapes. `PolicySession` uses oRPC's WebSocket
and MessagePort `RPCLink` adapters; it does not construct a parallel envelope,
maintain a second protocol, or send a request through more than one path.

## Covered policy

- authenticated handshake and exact protocol-version negotiation;
- monotonically increasing session generations on reconnect;
- synthetic correlation IDs and stale unary/event response rejection;
- bounded request deadlines and caller `AbortSignal` cancellation;
- negotiated message-size ceilings enforced before send and on receive;
- explicit disconnect, iterator cancellation, cleanup, and reconnect/recovery;
- bounded schema-versioned invocation/result transcripts that exclude tokens,
  request bodies, URLs, and raw wire messages.

The fixture under `tests/support/orpc-peer.ts` uses the installed oRPC
`ServerPeer` codec and peer implementation. Its WebSocket and MessagePort
endpoints are deterministic in-memory channels; every response, event, abort,
and cleanup is locally replayable without a real socket, Electron process, or
network effect.

## Evidence boundary

The Vitest suite proves the client policy, the oRPC adapter wiring, and the
contract/codec lifecycle against the simulated peer. It does not claim that
Electron's production `MessagePortMain`, a browser WebSocket implementation,
real authentication storage, a WebView, a packaged application, or a remote
network endpoint has been accepted. Those require a separate real-host
acceptance transcript and remain outside this POC.

## Verification

From the repository root:

```sh
pnpm --dir poc install --frozen-lockfile
pnpm --dir poc/orpc exec tsc -p tsconfig.json --noEmit
pnpm --dir poc/orpc exec vitest run
```
