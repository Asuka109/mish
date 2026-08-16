# macOS Transcript Fixtures

Host-effect fixtures are opt-in, disposable, and transcript-first. Each
invocation records a bounded operation name, redacted inputs, result class,
duration bucket, and cleanup outcome. Secrets, paths outside the fixture root,
tokens, and raw payloads are rejected before a transcript is persisted.

Replay uses the recorded semantic result and never invokes a host command. A
fixture may prove ordering, privacy, retry, or cleanup behavior; it cannot
prove a real permission, network, system setting, or privileged interface.

Ordinary CI uses deterministic fixtures only. Any local macOS capture must be
explicitly requested, reviewed for privacy, and kept out of the production
bundle and normal CI inputs.
