# macOS development Core host

This is the hands-on acceptance procedure for the development-only Stage 1
privileged Core host. It requires Apple Silicon macOS, a trusted checkout, the
stable Rust toolchain, Node.js, pnpm, `gh`, and an administrator account.

Stage 1 runs only a prepared Mihomo candidate with `tun.enable: false`. It does
not enable Virtual Interface, create a `utun`, change routes or DNS, change the
macOS System Proxy, install `SMAppService`, or add anything to a release bundle.
All product UIs remain System Proxy-only. The service is installed only by the
explicit commands below.

For a trusted Mac that must not install a checkout or development toolchain,
use the structurally separate
[`internal-tun-alpha` package profile](macos-packaging.md#internal-tun-alpha-service-package).
That package reuses this Helper, pinned Core, P-256 enrollment, and authenticated
disabled-state health contract, but exposes only package, install, status,
health, repair, and uninstall. It cannot enable TUN or mutate network state. Do
not copy its artifacts into `Mish.app` or use it as evidence for production
signing.

Issue acceptance may additionally exercise the complete development TUN path
inside a uniquely named disposable Tart clone. That path is documented in
[the helper contract](../architecture/macos-tun-helper.md#disposable-tart-tun-acceptance).
It does not weaken this Stage 1 command: ordinary development continues to
reject `tun.enable: true`.

## Disposable Tart TUN journey

Never run these commands on the host Mac or on a reusable VM. Clone a stopped
acceptance/base image, keep all administrator and network operations inside the
clone, and use only repository-owned fictional profiles:

```sh
pnpm prepare:mihomo
pnpm macos:tun:prepare:tart
pnpm macos:tun:install:tart
pnpm desktop:dev:tart-tun
```

The authenticated acceptance harness may then activate only
`fictional-tart.yaml`. Before considering activation Applied, require a
root-owned pinned Core plus a correlated Mish-owned `utun`, the complete
managed route partition, and the managed DNS effect on the one eligible
Wi-Fi/Ethernet service selected by the guest's actual default route. Record the
stable SystemConfiguration service identifier, BSD interface, exact prior DNS
servers, route table, scoped `.local` resolver, and System Proxy digest before
activation. Confirm public HTTP traffic through Mish with System Proxy
disabled, then confirm the pre-existing physical-interface route still handles
the guest LAN and that a `.local` Bonjour target such as a fictional guest
fixture remains reachable.

Exercise disable, normal Quit, forced app termination, helper and Core exit,
sleep/wake, network change, service replacement, foreign DNS, and one failed
activation. Each case must either restore the exact prior DNS and Mish-owned
network transaction or expose bounded recovery-required drift. A changed
service identity or foreign current DNS must never be overwritten; desired
state alone must never appear idle or Applied. Capture a redacted report, then
remove the service:

```sh
pnpm macos:tun:uninstall:tart
pnpm macos:tun:status
```

Verify the prior DNS and System Proxy state are restored and that no Mish-owned
interface, route, Core, helper socket, network-recovery record, receipt, or
installed privileged file remains. Finally stop and delete only the disposable
clone.

## Machine checks

Run the repository-owned automated checks first:

```sh
pnpm prepare:mihomo
pnpm macos:core-host:build
pnpm test:macos:bundle
cargo test -p mish-platform-macos --features development-core-host \
  -- --test-threads=1
```

The build command must finish without an administrator prompt. The tests cover
the pinned digest and version, canonical private candidate shape, configuration
size, TUN rejection, canonical P-256 transcript vectors, wrong
key/peer/command rejection, bounded challenge expiry and replay, dual-proof
rotation, administrator reset, one-owner lifecycle, bounded stop,
helper-parent crash watchdog, and release-artifact exclusion.

## Install and health

Install is the first command that may show the macOS administrator dialog:

```sh
pnpm macos:core-host:install
pnpm macos:core-host:status
pnpm macos:core-host:health
```

Accept the administrator dialog. Re-run `install` once to prove the operation
is idempotent. `status` must report `"service":"installed"`. `health` must
report `"ok":true`, helper protocol version `3`, a 64-character installation
identity, and the same `p256-sha256` enrollment key identifier and generation.
The user-owned
`~/Library/Application Support/com.asuka109.mish/runtime/tun-client-key.json`
must be a regular single-link mode-`0600` file. The root-owned enrollment file
must contain only the matching public key and metadata. The wire-level unsigned
discovery does not expose a Core launch token or network state;
`macos:core-host:health` uses authenticated status and reports `"core":null`.

Cancel one administrator dialog during a later reinstall. The command must
return `authorization-cancelled` and the previously healthy installation must
remain usable.

## Launch and stop the pinned Core

Prepare one private candidate without enabling TUN:

```sh
candidate_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
runtime_root="$HOME/Library/Application Support/com.asuka109.mish/runtime"
candidates_root="$runtime_root/candidates"
candidate_root="$candidates_root/$candidate_id"
mkdir -p "$candidate_root/home"
chmod 700 "$runtime_root" "$candidates_root" "$candidate_root" "$candidate_root/home"
cp docs/quality/fixtures/core-host-stage1.yaml "$candidate_root/config.yaml"
chmod 600 "$candidate_root/config.yaml"
cargo run -p mish-platform-macos --features development-core-host \
  --bin mish-core-host-ctl -- run \
  "$candidate_root/home" "$candidate_root/config.yaml"
```

Keep that terminal open. It must print `"status":"running"` with a positive
root-owned Core PID. In a second terminal, run:

```sh
pnpm macos:core-host:health
```

The same PID must be reported. Press Control-C in the first terminal. It must
print `"status":"stopped"`; the next health result must contain `"core":null`.

## Negative security checks

Repeat the `run` command with each invalid candidate. Every request must return
`core-host-start-rejected`, health must remain `"core":null`, and no `utun`,
route, DNS, or System Proxy change may occur:

1. Copy `config.yaml` outside the Mish runtime root.
2. Change the private config mode to `0644`.
3. Change the fixed fixture to `tun.enable: true`.
4. Pass a non-UUID candidate directory.

While one valid `run` command owns the Core, start another valid `run` command
from a second process. The second owner must be rejected and must not replace or
stop the first Core.

Use a second same-user client with a different private-key record in a
temporary mode-`0700` runtime root. Unsigned health discovery may return the
bounded version/enrollment metadata, but `status`, `run`, `disable`, and every
other consequential command must reject its proof. The trusted client must
continue to report no Core or the unchanged original Core, with no TUN, route,
DNS, or System Proxy mutation.

For helper-crash cleanup, start the valid candidate, then terminate only the
development helper with administrator authorization:

```sh
sudo pkill -9 -x mish-tun-helper
```

The separate watchdog must terminate the pinned Core within five seconds.
`launchd` may restart the helper, after which health must return with
`"core":null`. No candidate may be adopted as a new owner.

## Rotate and reset the internal key

With the helper healthy and idle, run:

```sh
pnpm macos:core-host:rotate-key
pnpm macos:core-host:health
```

Accept the administrator dialog. The key identifier must change, generation
must advance by exactly one, the old private key must no longer authenticate,
and the replacement key must survive app and helper restart. Interrupt one
fixture rotation before privileged commit and one after commit but before local
finalization; the first keeps the current key, while the second authenticates
through the mode-`0600` pending record and finalizes it on the next successful
command. There is no interval in which both public keys authenticate.

For the lost-key path, move the active private key into a disposable test
quarantine and run:

```sh
pnpm macos:core-host:reset-key
pnpm macos:core-host:health
```

Reset requires a new administrator authorization, advances generation once,
and leaves the helper idle with no Core or network effect. No ordinary socket
command can perform this reset. Remove only the disposable quarantined key
after the result is verified.

## Complete uninstall

Stop any foreground `run` command, then run:

```sh
pnpm macos:core-host:uninstall
pnpm macos:core-host:status
```

Uninstall must report `"service":"not-installed"` and the following fixed
targets must be absent:

```text
/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist
/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev
/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev
/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json
/var/run/com.asuka109.mish.tun-helper.<uid>.sock
/var/run/com.asuka109.mish.tun-helper.<uid>.sock.state
~/Library/Application Support/com.asuka109.mish/runtime/tun-client-key.json
~/Library/Application Support/com.asuka109.mish/runtime/tun-client-key.pending.json
~/Library/Application Support/com.asuka109.mish/runtime/tun-service-installer
```

Removed service artifacts and the installer receipt are moved into a uniquely
named `Mish Core Host Uninstall …` folder in the current user's Trash so the
non-secret operation is recoverable. The fixed root enrollment record and its
private directory are validated and deleted by the installed helper before
that helper is moved. The private installation-key records are deleted instead
of copied into Trash. The candidate created for this walkthrough is user-owned
test data and may be moved to Trash separately. Shared system directories are
intentionally left intact.
