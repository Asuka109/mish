# Traffic Data Contract

`traffic.snapshot` returns bounded observations with explicit units and
redacted labels. It is a read projection; the page may filter and sort rows but
does not own capture lifecycle or session ordering.

The XState/session actor accepts only current ordered results. Query retains a
bounded projection and the Traffic page owns view-only filters. Replay covers
empty, populated, malformed, and disconnected snapshots. No contract implies
packet capture, VPN/TUN attachment, or a real network effect.
