# Status Experience

Status is the first destination in the Mish Web product. It makes the
authenticated session, service health, and current projection legible without
turning transport or host effects into UI state.

## Information hierarchy

1. Page title and session status.
2. A compact health summary with explicit loading, unavailable, stale, and
   connected wording.
3. Current profile and route context.
4. Bounded traffic and event highlights.
5. Links to Routes, Profiles, Traffic, Events, and Settings for progressive
   detail.

The page is rendered by `StatusPage` and reads `status.snapshot` through the
shared session actor and Query facade. It never constructs a client, starts a
host operation, or claims a real network state from a fixture.

## Interaction rules

- text, structure, and iconography carry status meaning in addition to color;
- loading and unavailable states explain what is being awaited;
- stale data remains visibly marked and does not become a fresh command source;
- reconnect and failure surfaces are owned by the session actor;
- local filters, disclosure, and focus are presentation state;
- keyboard focus, reduced motion, and narrow-window layout remain usable.

The other five destinations use the same composition boundary while keeping
their own data table, filter, or settings presentation. Fixture replay covers
navigation and each operation's loading/success/unavailable rendering.
