# Mobile Core ABI v1

## Purpose

The Mobile Core ABI is the only supported native boundary between a Mish mobile
platform service and the embedded Mihomo Core. It is intentionally smaller than
Mihomo's Go package graph and independent of JNI, Kotlin, Swift, Tauri, and VPN
permission APIs.

The canonical C header is
[`../../mobile-core/abi/mish_mobile_core.h`](../../mobile-core/abi/mish_mobile_core.h).
The header uses non-const input pointers because cgo-generated exports cannot
preserve C `const` qualifiers. The implementation treats every input byte as
read-only and never retains a caller-owned input pointer.

## Compatibility

Every exported symbol ends in `_v1`. Existing v1 signatures and enum values may
not change. A future incompatible contract adds new symbols and types instead of
reinterpreting v1 memory. `MishCorePlatformV1.struct_size` permits compatible
callback-table extension.

`mish_core_abi_version_v1` and `mish_core_version_v1` are callable before
initialization. All other operations require a successful initialize call.

## Buffer ownership

The caller owns input bytes for the duration of one call. The Core allocates
every non-empty `MishCoreBufferV1.data` response with the C allocator. The caller
must invoke `mish_core_free_buffer_v1` exactly once after consuming either a
success or error response. Freeing an empty buffer is valid, and free resets the
pointer and length to zero.

Responses are UTF-8 JSON without a trailing NUL byte. Configuration input is at
most 1 MiB, command input is at most 64 KiB, and any response is at most 256 KiB.
The length fields are fixed-width `uint64_t` values rather than platform-sized
integers.

## Response and error envelope

Success responses use:

```json
{ "abiVersion": 1, "data": {} }
```

Errors use:

```json
{
  "abiVersion": 1,
  "error": { "code": "invalid-argument", "message": "bounded safe text" }
}
```

The function return value is the authoritative `MishCoreStatusV1`. Error text
is bounded to 512 bytes and must not contain configuration bytes, credentials,
paths, URLs, or a stack trace.

| Status             | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `OK`               | The requested state is authoritative and returned in `data`.      |
| `INVALID_ARGUMENT` | JSON, required fields, or a closed enum is invalid.               |
| `NOT_INITIALIZED`  | Initialize has not completed.                                     |
| `NOT_LOADED`       | Start was requested before a configuration was loaded.            |
| `CONFIG_REJECTED`  | Mihomo parsing failed or the mobile authority policy rejected it. |
| `CONFLICT`         | The command conflicts with the current session or phase.          |
| `LIMIT_EXCEEDED`   | An input, list, poll, snapshot, or response exceeded its bound.   |
| `UNSUPPORTED`      | The requested closed operation is not part of v1.                 |
| `FAILURE`          | Mihomo or the platform callback failed safely.                    |

## Lifecycle

Initialization accepts only `{"abiVersion":1}` and a platform callback table.
The socket-protection callback is mandatory and must remain valid until the
runtime stops. It returns zero only after the platform excludes the socket from
VPN recursion. Its `user_data` must be C-owned stable storage, not a Go pointer.

Validation and load accept effective YAML bytes. Before exact Mihomo parsing,
the wrapper rejects configuration-owned TUN state, listeners, Controller or UI
endpoints, remote or path-backed providers, automatic geodata updates, iptables,
and system clock mutation. The platform resolves and supplies all repository-
owned configuration bytes before the call.

Configuration replacement is atomic in ABI v1. A successful load replaces the
previous parsed configuration and reports its SHA-256 identity. Any non-`OK`
load status leaves the previous loaded configuration unchanged. Callers may
therefore preserve a previously confirmed healthy loaded identity only after a
well-formed error envelope and status pair. If the response is malformed,
oversized, interrupted, or otherwise cannot prove that v1 outcome, the caller
must publish loaded state as unknown and require recovery.

Start accepts one bounded DTO:

```json
{
  "machineAuthority": "mobile-profile-authority",
  "scopeEpoch": 7,
  "operationId": "activate-profile",
  "admittedRevision": 42,
  "effectIdentity": "1",
  "sessionId": "platform-authority-id",
  "tunFileDescriptor": 42,
  "stack": "mixed",
  "addresses": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
  "dnsHijack": ["1.1.1.1:53"],
  "mtu": 1500
}
```

`stack` is one of `gvisor`, `system`, or `mixed`; address lists contain at most
eight entries; and MTU is between 1280 and 9000. The platform owns creation and
closure coordination for the supplied descriptor. Start and stop both require
the five lifecycle authority fields. The wrapper retains the latest admitted
authority and rejects a foreign machine, older scope/revision, or unowned
same-revision effect with `CONFLICT` before mutation. Retrying the exact current
command is idempotent; an explicitly supplied session must own the running Core.
Cleanup for the same operation and admitted revision must carry the immediately
next decimal effect identity (`1` to `2`); suffixes, skipped effects, and
overflow fail closed across Kotlin, JNI, and the wrapper.

## Snapshots, commands, and events

Snapshot requests contain `kind` and an optional item `limit` no greater than 512. v1 supports `status`, `routes`, `traffic`, and `connections`. Snapshots map
Mihomo state into bounded DTOs and never return the upstream Controller payload
verbatim. Byte counters and event sequences are decimal strings so JavaScript
does not lose 64-bit precision.

Commands form a closed set:

- `set-routing-mode` with `rule`, `global`, or `direct`;
- `select-policy` with a bounded operation ID, current runtime authority,
  committed Profile identity/revision, stable group/current/target child IDs,
  and the Shared Rust-resolved native group/current/target labels;
- `close-connection` with one current connection identifier; and
- `close-all-connections`.

There is no generic Mihomo action, URL, filesystem path, shell command, or
Controller endpoint. Commands require a running Core and return an authoritative
status after mutation.

`select-policy` additionally requires the supplied runtime authority to match
the currently admitted lifecycle machine. The selector's observed current
child must match the request before `Set`. The wrapper retains at most 32
completed Route operation identities: an exact duplicate returns success
without another mutation or event, while the same operation ID with any
different authority, Profile, stable ID, or native label returns `CONFLICT`.
A successful configuration load clears that bounded cache. Shared Rust remains
the Profile relationship authority; Kotlin/JNI and the wrapper cannot derive a
new product membership from labels.

`mish_core_poll_events_v1` accepts a decimal `afterSequence` and a limit no
greater than 128. The Core retains at most 256 lifecycle and observation events.
The platform obtains a complete snapshot before accepting later events and
reconciles again if its requested sequence predates retained history.

## Implementation evidence

The Go reference wrapper uses the pinned Mihomo parser, executor, TUN listener,
policy-group interfaces, routing mode, and connection statistics directly. A
small C fixture exercises the complete contract without claiming a device VPN.
The Android validation bridge has a separate fake-native C harness that proves
bounded input, explicit initialization, status/envelope mapping, and exactly-once
response release without returning native response contents.
The Android artifacts are built from source with Go `c-shared` and explicit NDK
Clang targets.

The upstream API checks are pinned to Mihomo's exact
[configuration parser](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/config/config.go),
[executor](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/hub/executor/executor.go),
[TUN listener](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/listener/sing_tun/server.go),
and
[connection manager](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/tunnel/statistic/manager.go)
sources.

Authoritative build behavior is documented in
[`../../mobile-core/README.md`](../../mobile-core/README.md). The implementation
choices were checked against the official
[Go build modes](https://pkg.go.dev/cmd/go#hdr-Build_modes),
[cgo command](https://pkg.go.dev/cmd/cgo),
[Android NDK non-CMake builds](https://developer.android.com/ndk/guides/other_build_systems),
and [Android ABI](https://developer.android.com/ndk/guides/abis) documentation.
