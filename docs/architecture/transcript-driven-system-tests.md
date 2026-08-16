# Transcript-Driven System Tests

System-effect tests begin with a transcript contract. The test declares typed
invocations, bounded redacted inputs, result classes, and cleanup events before
any adapter implementation is exercised.

## Required record

Each record contains an operation name, sequence number, logical-time bucket,
redacted input summary, result classification, and cleanup status. Raw
credentials, arbitrary host paths, process environments, network payloads, and
unbounded logs are rejected. The schema is stable enough for deterministic
replay and privacy review.

## Replay and boundaries

Replay feeds semantic results to the XState actor without executing a command.
The production graph consumes the actor/contract seam, not a test fixture or
POC module. Browser, Electron, and RN tests remain separate so a passing
renderer test cannot be presented as host-effect evidence.

The current acceptance boundary proves graph shape, ordering, redaction,
failure rendering, and cleanup of disposable fixtures. It does not prove real
permissions, network availability, VPN/TUN behavior, system settings, signing,
publication, or deployment.
