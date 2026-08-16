# Runtime State Ownership

The runtime has three explicit layers and one session authority:

1. **Authority** — oRPC session and XState actor snapshots.
2. **Projection** — TanStack Query data keyed by operation and session.
3. **Presentation** — React local state and the small shared Store boundary.

Only the first layer may decide lifecycle transitions or ordered delivery. The
second layer may retain bounded server data and retry metadata. The third layer
may retain view choices, filters, tabs, expanded rows, and accessible focus
state. Presentation state never becomes a command source or an alternate
session authority.

## Session composition

`CutoverWebComposition` creates one Query client and one
`OrpcSessionAuthority`. The XState session actor controls connection setup,
teardown, and ordered event delivery. `CutoverViewProvider` exposes a typed
source to page hooks; it delegates to the session authority and Query rather
than maintaining generation/ticket/stale state of its own.

## Operation projections

The current view operations are `status.snapshot`, `routes.snapshot`,
`profile.refresh`, `traffic.snapshot`, `events.snapshot`, and
`settings.snapshot`. Each has a contract DTO, a query key, a loading/error
surface, and a replay fixture. The page may render an unavailable result but
must not instantiate a legacy client to fill the gap.

## Lifecycle and cleanup

Actors stop their subscriptions on composition disposal. Query observers are
disposed with the Query client. Host seams close transport resources in their
own boundary. Transcript records are bounded and redacted before assertion.
Cleanup evidence is a test contract; it is not a claim that an automated test
has exercised a real host permission or network resource.

## Completed tracker context

Issue #204, Issue #207, Issue #236, and Issue #305 were completed historical
state reviews. Their conclusions are superseded by the XState/session/Query
split above; none adds a second runtime to the production graph.
