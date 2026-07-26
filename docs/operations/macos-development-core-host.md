# macOS development Core host

This is the hands-on acceptance procedure for the development-only Stage 1
privileged Core host. It requires Apple Silicon macOS, a trusted checkout, the
stable Rust toolchain, Node.js, pnpm, `gh`, and an administrator account.

Stage 1 runs only a prepared Mihomo candidate with `tun.enable: false`. It does
not enable Virtual Interface, create a `utun`, change routes or DNS, change the
macOS System Proxy, install `SMAppService`, or add anything to a release bundle.
All product UIs remain System Proxy-only. The service is installed only by the
explicit commands below.

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
managed route partition, and the fixed DNS effect. Confirm public HTTP traffic
through Mish with System Proxy disabled.

Exercise disable, normal Quit, forced app termination, helper and Core exit,
sleep/wake, network change, and one failed activation. Each case must clean up
or expose bounded recoverable drift; desired state alone must never appear idle
or Applied. Capture a redacted report, then remove the service:

```sh
pnpm macos:tun:uninstall:tart
pnpm macos:tun:status
```

Verify the prior DNS and System Proxy state are restored and that no Mish-owned
interface, route, Core, helper socket, receipt, or installed privileged file
remains. Finally stop and delete only the disposable clone.

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
size, TUN rejection, stale and replayed requests, one-owner lifecycle, bounded
stop, helper-parent crash watchdog, and release-artifact exclusion.

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
identity, and `"core":null`.

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

For helper-crash cleanup, start the valid candidate, then terminate only the
development helper with administrator authorization:

```sh
sudo pkill -9 -x mish-tun-helper
```

The separate watchdog must terminate the pinned Core within five seconds.
`launchd` may restart the helper, after which health must return with
`"core":null`. No candidate may be adopted as a new owner.

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
/var/run/com.asuka109.mish.tun-helper.<uid>.sock
/var/run/com.asuka109.mish.tun-helper.<uid>.sock.state
~/Library/Application Support/com.asuka109.mish/runtime/tun-service-installer
```

Removed service artifacts and the installer receipt are moved into a uniquely
named `Mish Core Host Uninstall …` folder in the current user's Trash so the
operation is recoverable. The candidate created for this walkthrough is
user-owned test data and may be moved to Trash separately. Shared system
directories are intentionally left intact.
