# macOS platform transcript fixtures

## Boundary

The repository development command `macos:transcript:*` calibrates the production
`MacOsCommandRunner` parser and System Proxy adapter against bounded real macOS
tool output. It is opt-in and is not part of Mish, its desktop or mobile packages,
support bundles, release artifacts, or ordinary CI capture. Ordinary CI only
replays the checked-in fully synthetic fixture.

The first capture uses a uniquely named disposable Tart clone as the explicitly
selected real Mac. The base image remains stopped and unchanged. Capture runs
inside the guest with `LANG=C` and `LC_ALL=C` against a synthetic or explicitly
controlled System Proxy/network-service observation state. It does not require
root, change System Proxy, change DNS or routes, access traffic, or mutate the
host Mac.

## Capture, compile, and abort

Run these commands only inside the disposable guest. Choose a unique quarantine
name under the exact ignored root; no other output root is accepted.

```sh
pnpm macos:transcript:record -- \
  --output-root .scratch/macos-platform-transcripts/raw/mish-329-unique-capture

pnpm macos:transcript:compile -- \
  --input-root .scratch/macos-platform-transcripts/raw/mish-329-unique-capture \
  --fixture-id system-proxy-readonly-macos26-arm64 \
  --source real-tart \
  --fixture-out docs/quality/fixtures/macos-platform-transcripts/system-proxy-macos26-arm64.json \
  --privacy-diff-out docs/quality/fixtures/macos-platform-transcripts/system-proxy-macos26-arm64.privacy.md
```

The recorder invokes only fixed absolute programs and separately supplied fixed
arguments for macOS product/build/architecture evidence, the default route,
network-service order, and the six read-only System Proxy getters for the one
service mapped from the default route. Arbitrary programs, arguments, paths,
remote targets, shell evaluation, extra commands, and user-supplied service names
are not accepted. Each command has a five-second and 64 KiB stdout/stderr bound;
the raw manifest has a 1 MiB bound.

Raw output exists only in the mode-`0700` guest quarantine with mode-`0600`
files and an explicit sensitive marker. Do not print it, open it in host tools,
copy it through a shared mount, attach it, place it in a support bundle, or quote
it in a PR. Successful compilation deletes the quarantine. To abandon a capture,
run the explicit bounded cleanup:

```sh
pnpm macos:transcript:abort -- \
  --output-root .scratch/macos-platform-transcripts/raw/mish-329-unique-capture
```

Cleanup refuses unexpected, nested, linked, or special entries. A cleanup failure
is a visible command failure; candidate fixture/privacy outputs are deleted and
must not be accepted. Resolve cleanup inside the guest, use `abort`, and confirm
the quarantine is absent before stopping the clone.

## Compiler and privacy review

The compiler accepts a closed schema, exact command identities/arguments, closed
request and result kinds, bounded UTF-8, and allowlisted fields for each command.
Unknown fields and secret, credential, private-key, Profile/configuration,
traffic, packet, process-list, unrelated-route, and remote-target shapes are
rejected. They are not heuristically redacted.

Only these artifacts may leave the guest:

- the versioned JSON fixture with platform/product/build families, architecture,
  forced locale, fixed tool identity evidence, normalized requests, synthetic
  operands, typed results, bounded sanitized output, and provenance;
- the matching privacy diff, which reports replacement classes and counts but
  contains no original values or raw-evidence digest.

Review both exact files. Confirm every name, interface, hardware-port label,
proxy/PAC host, PAC path, and bypass/search domain is synthetic; repeated source
identities must retain the same pseudonym. Confirm the fixture contains no user
name, device name, real host/domain/PAC URL, credential, Profile bytes, token,
private key, traffic, packet data, process inventory, unrelated route, or raw
command fragment. Then run the compiler/schema/privacy tests and the production
adapter replay test. Human approval of this diff is required before merge.

## Refresh policy

Capture a new candidate when Mish changes the allowlisted command set, command
parser, normalized fixture schema, or supported macOS architecture, or when a
supported macOS/tool release changes an observed output shape. A new OS release
alone does not overwrite prior coverage: add or replace a fixture only after the
same quarantine, deterministic compile, privacy review, parser replay, cleanup,
and maintainer approval flow. Synthetic malformed/locale/version/truncation/
timeout/permission/unexpected-field/pseudonym/privacy/cleanup fixtures remain the
non-privileged failure matrix.

## First fixture evidence

The first checked-in candidate was captured on 2026-08-01 in the uniquely named
clone `mish-329-platform-transcript-20260801`, created from the stopped repository
base `ghcr.io/cirruslabs/macos-tahoe-base` at digest
`sha256:a8e1c8305758643f513fdccdd829c2243687c60791083dea42f73f0b7aeb435c`.
The guest was macOS 26.5, build family 25F, ARM64. The repository source and Node
runtime were mounted read-only, then copied into a guest-private task directory;
capture and compilation ran only there. No root command, System Proxy transition,
DNS/route mutation, host-network mutation, traffic probe, or production recorder
was used.

The final compiler run confirmed its uniquely named raw quarantine absent before
the guest was stopped. Exactly two files left the guest:

- `system-proxy-macos26-arm64.json` — SHA-256
  `a1c75df6966eb051120547325becd11b2038b4b816e584a47a8242fba27599fd`;
- `system-proxy-macos26-arm64.privacy.md` — SHA-256
  `df13246a227f006c55126c2427d131c1b15eec221d4df41eaef79c5247575703`.

The task clone remains stopped until hands-on acceptance, after which it is
deleted while the base remains unchanged. Acceptance is recorded in the PR and
assigned Issue, not self-declared by fixture provenance.

## Evidence limit

Tart proves actual macOS tool output and Mish adapter/parser conformance only for
that guest and build. It does not prove physical interface diversity, a real user
network, authorization UI, `launchd` or privilege behavior, propagation timing on
hardware, signing or notarization, rollback, TUN, packet flow, production
recording, or host-network safety beyond the stated no-host-mutation boundary.
Runtime/Capture semantic tests remain stateful and order-independent; they cannot
read the raw quarantine and do not assert this command sequence.
