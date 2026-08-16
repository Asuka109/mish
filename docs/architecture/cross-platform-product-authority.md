# Cross-Platform Product Authority

Mish has one product authority implemented in TypeScript. Hosts are projection
seams, not alternate implementations of the product.

| Concern                                               | Owner                                                  | Host responsibility                           |
| ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| Operation names, DTOs, and errors                     | `packages/contracts`                                   | Serialize the declared shape                  |
| Session, ordering, reconnect, and transcript delivery | `OrpcSessionAuthority` and `rpcSessionMachine`         | Supply a transport and close it               |
| Complex domain lifecycle                              | XState actors in `packages/domain` and Web composition | Report effect results through the actor seam  |
| Server projections and bounded retry                  | TanStack Query                                         | Provide the query client                      |
| Filters, tabs, disclosure, and view-only selection    | React components and `packages/ui-state`               | Render and persist no business truth          |
| Window and native host effects                        | Electron/RN seam                                       | Execute only explicitly admitted host effects |

## Session rule

There is exactly one session authority for a mounted Web composition. It owns
connection status and ordered delivery. Query caches are projections keyed by
operation and session identity; they are not a second lifecycle machine. A
page remount, reconnect, or stale response cannot mint a replacement business
authority.

## Domain rule

XState actors own state transitions that span more than one render: connection,
reconnect, profile selection, and other admitted domain operations. React
components send typed events and render snapshots. A helper that allocates
generations, tickets, stale flags, or conflict resolution outside the actor is
not an accepted replacement for the session/domain authority.

## Host rule

Electron and React Native import shared contracts and composition boundaries.
They do not import the POC tree or old wire adapters, and they do not expose a
compatibility client. Native effects are narrow seams with bounded transcript
records and deterministic replay. Production acceptance does not claim a real
network, permission, VPN, TUN, or system-proxy result.

## Tracker context

Issue #91 and Issue #94 were completed contract/fixture deliveries in the
superseded architecture and are not production dependencies. Issue #261 was a
completed authority review, while Issue #372 was superseded by the current
TypeScript host boundary. The current document is the final ownership model.
