# Lifecycle and Race Review

The final race boundary is the XState session/domain actor plus the single
oRPC session authority. Query observers consume snapshots; React Store holds
presentation only. No provider or helper may create a second generation,
ticket, stale-delivery, or conflict authority.

## Required invariants

- connect and dispose are serialized by the actor;
- every operation has a typed contract and bounded transcript record;
- stale transport results are rejected by the session actor before projection;
- Query keys include the admitted session identity and operation;
- view remounts do not reset domain authority;
- host cleanup closes transport/process resources within its boundary;
- unavailable native capability is a typed result, not a fallback client.

## Review outcome

The historical state audit for Issue #204, Issue #207, Issue #236, and Issue
#305 is complete. The old implementation documents are retired; this short
record preserves only the invariants that remain testable in the TypeScript
graph.
