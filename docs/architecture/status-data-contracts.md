# Status Data Contract

`status.snapshot` is a typed projection of connection and service health. It
contains stable display values, an explicit connection state, and bounded
diagnostic text. It does not expose a transport object or infer a host effect
from a missing field.

The session actor validates delivery before Query receives the snapshot. The
Status page renders loading, unavailable, stale, and connected states with
text and structure in addition to color. Fixtures cover accepted, malformed,
stale, and disconnected results without using a compatibility adapter.
