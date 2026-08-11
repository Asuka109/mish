# RPC Session Authority Contract

## Boundary and ownership

`RpcSessionAuthority` is the single Web-side owner of transport-session
acceptance for ordered RPC snapshots. It owns the connection generation,
request/subscription tickets, the baseline barrier, reconnect replacement
window, stale delivery rejection, duplicate detection, equal-order conflict
classification, and `applicationOrder` acceptance.

The wire client remains responsible for request deadlines, cancellation
metadata, collision-safe request IDs, JSON-RPC envelopes, correlation, and
schema validation. Domain clients remain responsible for method parameters,
typed errors, subscription identity, and DTO projection. Providers remain
responsible for React state, command feedback, and presentation lifecycle.
Neither layer may reimplement the transport acceptance policy.

The intended pipeline is:

```text
transport and envelope validation
        -> RpcSessionAuthority ticket/acceptance
        -> domain DTO projection and provider state
        -> UI
```

This is a transport/session contract, not a replacement for product or
platform authority. `applicationOrder` is carried by the product DTO, but the
client-side acceptance decision is centralized here.

## Acceptance pipeline

Every RPC snapshot delivery follows the same sequence:

1. Observe the transport phase through `observeTransport`. A real reconnect is
   represented by a disconnected or reconnecting phase followed by a new
   connected phase; consumers do not synthesize a second generation.
2. Start a request or subscription with `beginRequest` or
   `beginSubscription`. An adapter that can return a complete initial request
   snapshot before its connection callback arrives may pass
   `beginRequest({ bootstrap: true })`; the authority permits this only before
   generation one and never reopens an existing session.
3. Pass the ticket and validated DTO to `accept` with the delivery kind
   (`baseline`, `update`, `command`, or `request`).
4. Project only `accepted` results. Keep the authority's current snapshot for
   `stale`, `duplicate`, or `conflict` results, and surface a conflict through
   the owning domain error/state when the domain requires it.

The authority clones an accepted snapshot before retaining it. A subscription
baseline establishes the post-connect observation session; an update cannot
cross that barrier. A replacement authority is accepted only by a baseline or
by a command/request inside the reconnect window. A late ticket from another
generation is stale even when its DTO has a larger order.

## Consumer rules

The production RPC clients and Web providers that consume ordered snapshots
must import and use `RpcSessionAuthority`. They must not:

- compare `ticket.generation` or call `getGeneration` to decide delivery
  validity;
- maintain a second baseline, reconnect, stale-response, duplicate, conflict,
  or `applicationOrder` ordering policy;
- accept a snapshot before a ticket has passed through the shared authority;
- turn a repeated connected callback into a synthetic disconnect/connect pair.

The static repository gate and the focused `RpcSessionAuthority` tests enforce
these rules. The legacy `ApplicationSnapshotAcceptance` module is retired;
new consumers must not import or recreate it.

## Deliberate domain and platform exceptions

The shared session authority does not erase narrower ownership boundaries:

- Status keeps recent-Traffic and Capture-operation projection because those
  are nested product authorities, not transport ordering.
- Traffic keeps observed source-session and command-capability projection.
- Updater keeps its DTO-specific accepted revision projection after the shared
  session envelope is accepted.
- Profile keeps selection projection, and Notifications keep presentation
  leases/claims and their synthetic presentation session.
- Fixture adapters may advance their deterministic fixture snapshots.
- `MobileVpnFixtureClient` keeps the Android lifecycle authority at the mobile
  platform boundary.

These exceptions must not mint RPC transport generations or bypass the shared
`accept` call. They are documented domain/platform projections and remain
covered by their owning tests.

## Deterministic evidence and limits

The package authority tests cover generation binding, baseline barriers,
replacement, stale deliveries, duplicates, equal-order conflicts, and newer
deliveries. Web RPC/client/provider tests cover each migrated consumer, and the
static gate checks the import/forbidden-pattern contract and this document.

These are deterministic RPC/Web and fixture-backed checks. They do not prove
real macOS, TUN, signing, notarization, release, physical-device, or external
network behavior. Real-host acceptance remains a separate platform and release
boundary.

## Maintenance gate

Run `node scripts/check-rpc-session-authority.ts` when changing an ordered RPC
consumer, and keep it in `check:docs` and `test:unit`. Update this contract in
the same change when ownership or an intentional exception changes.
