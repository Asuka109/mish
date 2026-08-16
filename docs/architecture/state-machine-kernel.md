# XState Lifecycle Convention

This document records the final lifecycle convention after the repository-owned
runtime retirement. Product lifecycle is represented by XState actors and
typed events; a custom reducer/runner or compatibility state machine is not a
production dependency.

## Actor contract

An actor owns a bounded state snapshot, typed events, invoked operations, and
deterministic cleanup. Effects return typed results through the contract seam.
React renders snapshots and sends events; it does not recreate the machine on
every render. Query caches remain projections and Store remains presentation.

## Session actor

`packages/orpc-client` supplies `OrpcSessionAuthority`; the Web composition
uses `rpcSessionMachine` to coordinate connect, reconnect, event delivery, and
dispose. Session identity and delivery ordering are tested with bounded
transcripts and replay. There is no parallel generation/ticket authority in a
provider or helper.

## Domain actors

Complex product flows belong in `packages/domain` or the shared Web actor
composition. A host may implement only a narrow native effect seam and must
return a typed result. It cannot introduce a native product lifecycle,
fallback client, or shadow writer.

## Tracker context

Issue #288 was delivered and closed by the lifecycle work recorded in this
convention. It is historical tracker context and does not authorize restoring
retired runtime code.
