# Events Data Contract

`events.snapshot` returns a bounded ordered list of typed event observations.
Each event has an opaque event ID, timestamp bucket, severity, title, and
redacted detail. The contract carries no credentials, filesystem path, raw
network payload, or host-specific lifecycle object.

The session actor owns ordering and disconnect semantics. TanStack Query
projects the latest bounded snapshot; the Events page owns filters and row
disclosure. A replay fixture covers duplicate, out-of-order, malformed, and
redacted events. It does not claim a real service event stream.
