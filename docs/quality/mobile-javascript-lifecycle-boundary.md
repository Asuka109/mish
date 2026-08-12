# JavaScript mobile lifecycle boundary

This note records the D1.3 Web projection boundary. The JavaScript client does
not own the VPN lifecycle. Rust remains the command, operation, session,
revision, sequence, cancellation, and cleanup authority; Kotlin remains the
Android effect/facts adapter. The client accepts only a complete native
baseline and then projects newer observations from that same authority.

## Boundary matrix

| Effect / delivery     | Owning seam and authority                                      | Invocation / result                                                                        | Recording and deterministic use case                                                                   | Privacy / exclusion                                                                       | Evidence limit                                                   |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Initial snapshot      | Tauri `get_snapshot` → Rust lifecycle projection               | `get_snapshot` → `MobileVpnSnapshot`                                                       | `MobileVpnFixtureClient` generation trace; `initial-load-before-newer-notification`                    | Closed DTO schema; Web-only client, no host values                                        | Does not prove Android bind or device behavior                   |
| Snapshot subscription | Tauri `mish-vpn://snapshot` → Rust event publisher             | `MobileVpnEvent` with authority/session/revision/sequence                                  | Bounded pre-baseline coalescing; `stale-old-authority`, equal-order conflict, valid replacement        | Strict event/snapshot schemas; transport carries no config/credential bytes               | Does not prove native callback timing                            |
| Configuration load    | JS load seam → Rust `load_config` → Kotlin/Mobile Core effects | bounded fictional bytes + identity → typed load result and optional authoritative snapshot | `late-load-after-newer-notification`, `abort-during-load`, `dispose-remount`                           | 1 MiB bound, digest/revision/operation checks, payload zeroed; no product lifecycle in JS | Does not prove Core/TUN/packet flow                              |
| Lifecycle command     | JS command seam → Rust `start`/`stop`/permission commands      | operation ID → terminal/unknown `MobileVpnCommandResult`                                   | Abort routes exactly once through `cancel_lifecycle_operation`; retired generation ignores late result | Strict DTO validation; mock transport only                                                | Does not prove Android effects or cleanup completion on hardware |
| Unmount/dispose       | JS client/hook cleanup                                         | listener unregister + native cancellation request                                          | `dispose-remount` and hook mounted guard                                                               | No test-only code in production graph; no host mutation                                   | Does not prove Activity/WebView recreation on device             |

The trace is bounded semantic evidence only: generation phase and closed
authority/order/acceptance fields. It records neither raw native responses nor
configuration contents.

## Named deterministic cases

- initial load accepts the complete baseline, then accepts a newer notification
  and rejects a late load snapshot;
- abort during load invokes the native cancellation barrier and keeps the
  authoritative rollback snapshot;
- dispose retires in-flight lifecycle work, unregisters the subscription, and
  prevents late delivery; a remount requires a fresh baseline;
- an old authority/session and equal-order conflicting snapshot are rejected;
- a valid replacement authority is accepted once and retires the prior one;
- malformed/failure/cancellation results remain typed and redacted.

The tests use the production TypeScript client and a transport-only injected
bridge. No JavaScript reducer advances VPN phase or creates a replacement
authority. The repository's generated-contract and mobile capability checks
continue to enforce production exclusion.
