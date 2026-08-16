# Support Data Contract

Support diagnostics are bounded, redacted transcript projections. A preview
contains categories and safe metadata; it never embeds credentials, raw
configuration, arbitrary paths, or an unbounded event log. Saving or exporting
is outside the current CUT-06 production graph and must not be emulated by a
fixture client.

Privacy tests assert structural redaction and replay the same result without
filesystem or network effects.
