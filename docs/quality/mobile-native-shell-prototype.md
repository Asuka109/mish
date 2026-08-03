# Mobile Native Shell Prototype Validation

## Purpose

This is the hands-on contract for the Issue #343 research candidates. It does
not validate a product shell, VPN, Core, Packet Tunnel, release artifact, or
distribution candidate. Passing one platform does not imply the other platform
passes.

The architecture matrix and limitations are in
[`../research/mobile-native-shell-ownership-2026-08-03.md`](../research/mobile-native-shell-ownership-2026-08-03.md).

## Automated authority contract

Run the research-only Shared Rust state model:

```sh
cargo test -p mish-mobile-navigation-prototype
```

The tests cover the closed native/deep-link shell inputs, top-level selection,
one-way Web entry reset, full external deep-link forwarding, source/action
rejection, stale intent rejection, duplicate idempotency, and invalid-link
non-mutation. There is deliberately no React/Web intent, route stack, back, or
focus API in this crate. The tests do not prove native rendering, Tauri JNI/FFI
integration, or device bridge latency.

## Android build and launch

The Android candidate is a debug source-set Activity. It uses the existing
Material Components dependency and is absent from release source sets.

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export PATH="$(dirname "$(rustup which cargo)"):$ANDROID_HOME/platform-tools:$PATH"

pnpm mobile:android:init
pnpm --filter @mish/mobile exec tauri android build \
  --debug --target aarch64 --apk --ci
```

Use an isolated API 36 emulator. Do not install the research APK on a connected
personal device without an explicit device-level decision.

```sh
"$ANDROID_HOME/emulator/emulator" \
  @codex_issue282_api36 \
  -no-snapshot-save -port 5556

adb -s emulator-5556 install -r \
  apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb -s emulator-5556 shell am start -n \
  com.asuka109.mish/.ShellPrototypeActivity
```

An explicit child-route launch is available for deep-link projection testing:

```sh
adb -s emulator-5556 shell am start -n \
  com.asuka109.mish/.ShellPrototypeActivity \
  --es prototype-route /settings/network
```

Stop the prototype with the ordinary app switcher or:

```sh
adb -s emulator-5556 shell am force-stop com.asuka109.mish
```

Force-stop is permitted only for this isolated debug candidate and does not
prove product lifecycle behavior.

## Android hands-on matrix

Record the exact APK SHA-256, emulator API/build, WebView version, navigation
mode, font scale, animation scale, appearance, and timestamp. Use a short screen
recording for gesture and ripple behavior; screenshots alone are insufficient.

### Native chrome and state

1. Tap each of the five labeled destinations at its center and near both icon
   edges. The touch-origin ripple/state layer must stay clipped to the Material
   item/indicator, while the complete bar remains unclipped.
2. Hold, cancel, and release a tap. Pressed feedback appears immediately, but
   selected state and the one-way Web entry change together only after the
   Shared Rust shell revision increments.
3. Use **Disable Profiles**. Profiles becomes visibly and accessibly disabled,
   cannot receive selection, and does not change the shell revision. Re-enable
   it and confirm normal selection.
4. Reselect the active destination. It remains on the same route and announces
   that it is already selected; no duplicate route is pushed.

### Boundary, back, and deep links

1. Inspect the final debug source and runtime. There must be no
   `addJavascriptInterface`, `JavascriptInterface`, `NativeRouteBridge`, custom
   URL command, or Web-facing native shell command. Web buttons must change only
   Web-owned internal history.
2. Open an internal Web child. The visible Web path and Web back availability
   change, while native selected tab and Rust shell revision remain unchanged.
3. Begin the edge-back gesture slowly and cancel halfway. Web path/history and
   native shell selection/revision remain unchanged. Complete it: Web history
   pops once without a Rust shell transition.
4. Back at the Web root transitions toward system home once. It must not flash a
   second route, double-pop, change native selection, or invoke a Rust back path.
5. Repeat with three-button navigation and the top app-bar Back affordance.
6. Launch `/traffic?tab=rules`, `/events`, `/routes/streaming`, and
   `/settings/network` as platform deep links. Rust selects the matching shell
   destination once and emits the full entry path toward Web. Later internal Web
   navigation must not report back to Native.
7. Confirm the mobile Web content exposes no cross-section link. Primary
   destination changes originate only from native tab/drawer chrome or a
   platform deep link.

### Insets, keyboard, and recreation

1. Exercise gesture and three-button navigation, portrait and landscape. The
   toolbar, Web content, and bottom navigation remain clear of system bars and
   cutouts with no doubled or ghost padding.
2. Focus **Keyboard inset probe**. The field scrolls into the resized visual
   viewport. The native navigation may yield to the IME, but it must return
   unchanged after dismissal without doubled padding or a cleared route.
3. Rotate with a Web child route and with the native sheet open. The prototype may
   recreate because it is deliberately not production state restoration, but
   it must never display two selected tabs or two bars.

### Appearance, motion, and accessibility

1. Use **Toggle appearance**. System-bar icon contrast, Material chrome, Web
   `color-scheme`, selected/disabled states, and focus remain legible in light
   and dark appearance.
2. Set the system animator duration scale to zero. Predictive-back custom route
   translation is absent, navigation still commits once, and no control becomes
   unavailable. Restore the prior developer setting after the test.
3. Run Accessibility Scanner and traverse with TalkBack: top-bar Back/Sheet,
   Web heading and controls, then five labeled destinations. Confirm selected
   and disabled announcements, stable traversal, and practical targets.
4. Open and dismiss **Sheet** using touch, keyboard, and TalkBack. It must be
   reachable only from native chrome. Web content regains ordinary focus and no
   shell revision or Web route changes.

## Android automated/supporting inspection

After the hands-on path, capture supporting non-visual evidence:

```sh
adb -s emulator-5556 shell uiautomator dump /sdcard/mish-shell-prototype.xml
adb -s emulator-5556 pull \
  /sdcard/mish-shell-prototype.xml \
  .scratch/mish-shell-prototype.xml
adb -s emulator-5556 shell dumpsys activity top
adb -s emulator-5556 shell dumpsys window
```

The UI hierarchy can confirm labels, bounds, selected/disabled state, and one
Activity. It cannot prove ripple clipping, gesture motion, focus announcement,
or visual contrast.

The source boundary must also stay closed:

```sh
if rg -n \
  'addJavascriptInterface|JavascriptInterface|NativeRouteBridge|WKScriptMessageHandler' \
  apps/mobile/src-tauri/gen/android/app/src/debug \
  prototypes/mobile-shell/ios; then
  exit 1
fi
```

This negative check is necessary but not sufficient: hands-on inspection must
also confirm that no custom URL scheme or Web-facing Tauri command provides an
equivalent shell/native escape hatch.

## iOS and iPadOS source candidate

The candidate is a Swift Playgrounds/Xcode package:
[`../../prototypes/mobile-shell/ios/MishShellPrototype.swiftpm/Package.swift`](../../prototypes/mobile-shell/ios/MishShellPrototype.swiftpm/Package.swift).

Open it in Xcode 26 or later and run on exact iOS 26 and iPadOS 26 simulators.
This research host cannot perform that step because Xcode, iOS SDKs, and
Simulator are unavailable. The maintainer accepted the architectural direction
on 2026-08-04, but the Apple candidate remains **source-ready, uncompiled, and
unrun**; no runtime behavior is accepted as evidence until an authorized host
runs the matrix below.

## iOS and iPadOS hands-on matrix

Record the Xcode build, SDK, runtime, simulator/device, size class, Dynamic Type,
appearance, accessibility settings, pointer/keyboard input, commit, and app
artifact identity.

### System tabs, navigation, and materials

1. On iPhone compact width, confirm five stable labeled system tabs at the
   bottom. Select/reselect each and confirm one selected shell destination and
   one-way Web entry directive.
2. Inspect controller/WebView containment. Exactly one Tauri-owned `WKWebView`
   occupies the content boundary; switching tabs must not create one WebView per
   tab or native product screens.
3. Navigate to an internal Web child, then cancel and complete the platform back
   gesture. Cancellation changes neither Web history nor shell revision;
   completion pops Web history once without a Rust/native route-stack commit.
4. Scroll long content through top and bottom edges. System navigation and tab
   chrome apply current scroll-edge and Liquid Glass behavior; tab minimization
   must not hide location or make a destination unreachable.
5. Confirm the candidate uses system material. No CSS/custom blur, gradient,
   captured wallpaper, or manually drawn glass is acceptable evidence.

### iPadOS compact and regular

1. Run portrait, landscape, split view, and Stage Manager widths. Confirm the
   system chooses a compact tab or adaptable tab/sidebar form without showing
   the Mish desktop sidebar.
2. Resize across compact/regular boundaries with a Web child route and
   native-origin shell sheet open. Shell selection remains Rust-owned, Web
   history/focus remains React-owned, and there is still exactly one WKWebView.
3. Exercise pointer hover and Full Keyboard Access over tabs, toolbar actions,
   content controls, and sheet controls. System shortcuts must not conflict with
   text entry or platform shortcuts.

### Accessibility and environment

1. Traverse with VoiceOver. Tabs announce label and selection, Back and toolbar
   actions are concise, route heading follows a committed route, and sheet
   dismissal returns focus.
2. Test every accessibility Dynamic Type size. Titles, labels, environment facts,
   list rows, sheet controls, and tab destinations remain operable without
   clipping or horizontal-only access.
3. Enable Reduce Motion. Large spatial/custom transitions are removed or reduced
   while navigation remains understandable.
4. Enable Reduce Transparency, then increased contrast. System chrome adapts to
   an opaque or more legible treatment without changing the saved product
   appearance or hiding selection.
5. Repeat light/dark appearance with Reduce Motion and Reduce Transparency
   independently; these settings are not one combined fallback.

### Strict WebView boundary

1. Inspect the WKWebView configuration and Tauri command surface. There must be
   no `WKScriptMessageHandler`, custom URL command, or Web-facing Tauri command
   for tabs, drawers, native sheets, haptics, permissions, back, or focus.
2. Trigger every Web control in the candidate. It may navigate, open a Web
   sheet, mutate Web pending state, and call separately audited Shared Rust
   product APIs, but it cannot present or mutate Native UI.
3. Trigger every native shell destination and platform deep link. The accepted
   Rust shell snapshot emits one entry path toward React Router; React does not
   acknowledge later internal paths back to Native.

## Acceptance and evidence labels

- Authority tests passing permit only a **navigation contract prototype** claim.
- Android build and emulator launch permit only an **Android native-shell
  prototype** claim.
- Apple source inspection permits only an **Apple source candidate** claim.
- Each platform recommendation requires its complete hands-on matrix and an
  explicit maintainer accept/reject decision.
- Neither prototype is product implementation evidence, mobile VPN evidence,
  Packet Tunnel evidence, or release evidence.
