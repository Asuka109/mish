# Settings Data Contract

`settings.snapshot` returns the typed client settings projection. Settings
controls render the current value, pending state, and typed unavailable/error
result. A future mutation must be an explicit contract operation and XState
event; a component must not write hidden state or emulate a retired host API.

Query owns the read projection. Store owns only local presentation choices such
as the selected section or disclosure. Fixtures cover default, changed,
malformed, and disconnected snapshots without external writes.
