# Profile Domain

`profile.refresh` returns typed profile metadata and selection context. The
profile page renders source, active marker, and route context; selection or
activation lifecycle belongs to an XState actor and is not implemented as a
component-local command queue.

Profile DTOs contain bounded display data and redacted errors. Query projects
the latest response under the authenticated session. Tests replay empty,
selected, malformed, and unavailable results. Local form state is
presentation-only and cannot become a second authority.
