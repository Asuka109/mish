# macOS P0 Acceptance

## Scope

This gate proves the daily macOS prototype path:

`import -> validate -> activate -> capture -> change routing -> observe -> restart -> recover -> stop`

It covers local-file and HTTPS profile sources, Rule/Global/Direct routing,
confirmed System Proxy ownership, Status, Routes, Traffic, Events, safe Core
restart, failed activation rollback, System Proxy drift recovery, and safe stop.
TUN, Intel packaging, Developer ID signing, and notarization are outside this
gate.

## Automated fixture journey

Run from the repository root:

```sh
pnpm test:macos:p0
```

The test uses only repository-owned fictional YAML and in-process fixtures. The
HTTPS source is represented by a bounded fixture reader using an
`https://fixture.invalid/` source identity; it performs no network request. The
Core executable, Controller, Traffic and Events streams, and System Proxy
platform are also local fixtures. No account, subscription, credential, proxy
server, or machine network setting is used.

The journey proves that:

1. local-file and HTTPS sources pass the same preflight, normalization, preview,
   and persistence boundary;
2. a persisted profile activates only after Core, Controller, Status, Traffic,
   and Events readiness;
3. Rule, Global, and Direct changes are confirmed from the Controller;
4. System Proxy is reported applied only after the platform state matches the
   managed loopback endpoint;
5. switching from the local profile to the HTTPS profile preserves explicit
   capture intent;
6. restarting the active profile replaces the runtime and restores confirmed
   capture;
7. a validation failure leaves the prior healthy profile and capture state
   authoritative;
8. external System Proxy drift exposes both recovery choices and Repair restores
   the managed state; and
9. Stop returns to safe-stopped state, restores the prior System Proxy state,
   and clears the recovery journal;
10. deleting and reimporting the same fictional HTTPS identity creates a fresh
    profile ID, and a reconstructed desktop coordinator activates that new ID
    without restoring stale capture intent; and
11. an invalid recovery journal blocks capture restoration and repeated
    activation with a typed `capture` failure, exposes only **Leave as is**, and
    emits static actionable Events guidance without fixture URLs or Controller
    credentials.

The invalid-journal loop completes against local fixtures without a fixed
network-transition delay. It distinguishes Mish persistence and activation
state from any installed-app Mihomo or macOS network transition; timing of real
traffic interruption remains a manual observation.

## Manual installed-app acceptance

Use a dedicated macOS test account or a test machine. Start with System Proxy
disabled and no prior Mish application data. Use the verified Apple Silicon
test package described in
[`../operations/macos-packaging.md`](../operations/macos-packaging.md). Keep any
private profile or subscription address inside the Mish UI only. Do not place
it in shell history, notes, screenshots, issue text, logs, or a pull request.

Record only pass/fail, the Mish commit, macOS version, and whether the source was
`local` or `https`.

### Happy path

1. Launch Mish. Confirm Status is safe stopped, System Proxy is off, no profile
   is active, and TUN is unavailable rather than simulated.
2. Open Profiles and import
   `crates/desktop-bridge/tests/fixtures/p0-profile.yaml` with the native file
   picker. Confirm the preview reports one proxy, one group, and two rules; save
   it without activation.
3. Activate the saved profile. Confirm Status becomes healthy and names the
   active profile. Confirm Routes shows the fixture group, Traffic becomes
   ready, and Events shows a current session or an explicit source-specific
   unavailable state without degrading Status or Traffic.
4. Enable System Proxy. In macOS Network settings, confirm the active service
   uses Mish's loopback endpoint for HTTP, HTTPS, and SOCKS. Return to Mish and
   confirm the state is applied, not merely selected.
5. Change Rule -> Global -> Direct -> Rule. After every change, confirm Status
   shows the selected mode and remains healthy. Confirm Routes remains scoped
   to the active profile.
6. Generate ordinary, non-sensitive test traffic. Confirm Traffic updates and
   Events remains usable. Do not capture screenshots containing private host,
   route, node, or profile labels.
7. Import an HTTPS profile by entering its private address only in the Mish UI.
   Confirm the preview does not repeat the complete address, then save and
   activate it. Confirm the active profile changes while System Proxy remains
   applied.
8. From the Mish status-bar menu choose **Restart Core**. Confirm the active
   profile returns healthy, the main window remains usable, and System Proxy is
   re-confirmed without leaving an intermediate OS configuration behind.
9. In Profiles choose **Stop safely**. Confirm Status becomes inactive, System
   Proxy returns to the exact prior macOS state, and Routes, Traffic, and Events
   distinguish stopped/unavailable data from live data.
10. Quit and relaunch Mish. Confirm startup is safe stopped and does not
    automatically activate a profile or enable System Proxy.

### Failure recovery

1. Attempt to import malformed YAML. Confirm preflight fails before save and no
   profile becomes active.
2. With a healthy profile and System Proxy applied, disable or change the proxy
   manually in macOS Network settings. Confirm Mish reports drift and offers
   **Repair** and **Leave as is**. Choose Repair and confirm the managed state is
   applied again. Repeat and choose Leave as is; confirm Mish relinquishes
   ownership without overwriting the external state.
3. Re-enable System Proxy, then terminate the Mish-managed Mihomo process from
   Activity Monitor. Confirm Mish stops claiming healthy capture and restores
   the prior macOS proxy state. Choose the status-bar Core recovery action and
   confirm the active profile and explicit capture intent return only after the
   runtime is healthy.
4. Quit Mish while System Proxy is applied. Confirm the prior macOS state is
   restored and no managed Mihomo process remains.
5. Delete the HTTPS profile, import the same private address again, and confirm
   the newly saved profile activates after quit and relaunch. Capture must remain
   off until explicitly enabled; repeated activation or capture failure must
   identify System Proxy recovery and leave an actionable redacted event.

Any false success, active System Proxy left after Stop/Quit/Core failure, loss
of the prior healthy profile after failed replacement, or Status/Traffic loss
caused only by an Events failure blocks P0 acceptance.
