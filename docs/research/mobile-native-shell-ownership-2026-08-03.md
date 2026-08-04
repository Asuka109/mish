# Mobile Native Shell Ownership Research

## Decision status

This report is the Issue #343 architecture decision. The maintainer accepted the
Android and Apple platform directions and the strict Native-to-Rust-to-Web
boundary on 2026-08-04. The decision authorizes only the bounded follow-up slices
below; it does not itself authorize a mobile-shell rewrite. No product shell,
runtime dependency, or product behavior changes in this pull request. The
Android and Apple candidates remain research-only prototypes.

The recommended installed-mobile boundary is:

- Shared Rust remains the only product authority for Profiles, capture, Core,
  Routes, Traffic, Events, Settings, notifications, ordering, and recovery.
- One small Shared Rust **mobile shell authority** owns only the installed-mobile
  top-level tab/drawer selection and emits a one-way Web entry directive after a
  native-chrome or platform deep-link intent. It owns no Web route stack, back
  state, or DOM focus.
- Android and Apple native chrome submit shell intents to Rust and render the
  accepted selected destination. The host then directs the single WebView to the
  accepted entry path. Native chrome never mirrors the current internal Web path.
- React Router remains the only authority inside the WebView: product routes,
  history, internal back, page/sheet state, and DOM focus stay in the Web layer.
  Mobile Web content is confined to the selected top-level section and exposes
  no API for invoking Native UI or capabilities.
- The boundary is strictly one-way for navigation: Native shell -> Shared Rust
  shell authority -> WebView entry directive. There is no `JavascriptInterface`,
  script message handler, Tauri command, or callback by which Web content asks
  Native to open a sheet, change a tab, navigate, haptic, or permission surface.
- Android initially uses selective Material Views already present in the APK,
  not Compose or MUI, for the persistent navigation and app bars. Compose becomes
  worthwhile only if a later accepted slice moves a complete native screen or
  adaptive pane into Android UI.
- iOS and iPadOS use system-owned tabs, shell navigation/toolbars, native-origin
  sheets, materials, and adaptive sidebar behavior. UIKit is the production host
  integration candidate around Tauri's `WKWebView`; SwiftUI is the concise
  behavior prototype and remains an option after the iOS host boundary exists.

This proposal preserves the existing React Router authority for Web content and
adds a disjoint outer-shell authority in Shared Rust. Each state domain has one
writer; neither layer mirrors or commits the other's history. The accepted
direction becomes a product contract only through bounded implementation Issues
that change the architecture and validation documents together.

## Evidence baseline and limits

Research was refreshed on 2026-08-03 against Mish `a77933c`, Android API 36,
Tauri 2.11.5 (`tauri-runtime-wry` 2.11.4), and the official sources linked
below.

Repository evidence:

- Issue #324 is closed and its accepted Android baseline is on `main`: one
  mobile body scroller, viewport-bounded bottom navigation, complete corners,
  and non-reflowing notification presentation.
- Mish already targets Android 16/API 36, calls `enableEdgeToEdge()`, enables
  predictive back in the manifest, and packages Material Components Views.
- The current mobile shell renders top and bottom chrome in React and derives
  selection from `useLocation()`.
- Tauri's current Android app plugin registers an `OnBackPressedCallback`; with
  no listener it calls `WebView.goBack()` or the Activity back path. A native
  shell implementation must replace that default with one host callback that
  delegates back toward the Web router or it can double-pop Web history.
- Tauri's current iOS API exposes the created `WKWebView` and containing
  `UIViewController` to mobile plugins, but its documented plugin lifecycle does
  not provide a supported declarative API for replacing the generated root
  controller with a tab/navigation container.

Maintained implementation evidence:

- Google's Now in Android at
  [`7d45eae`](https://github.com/android/nowinandroid/tree/7d45eae4f8720a0c77f507712ba2437ff974b6ed)
  uses Material 3 `NavigationSuiteScaffold`, native navigation items, adaptive
  window information, explicit inset consumption, and one navigation state.
  Its navigation wrapper forwards selected/enabled semantics to Material rather
  than recreating ripple or accessibility behavior.
- Tauri at
  [`020919a`](https://github.com/tauri-apps/tauri/tree/020919a1b5d2c1faa9deb972a31a1a11d0ae8ce6)
  shows the exact Android back callback and iOS WebView/controller hooks used in
  this analysis. These source references are implementation evidence, not a
  claim that Tauri already supplies a native-shell abstraction.
- Apple's current Landmarks and Destination Video samples exercise system
  `NavigationSplitView`, `TabView`, adaptable sidebars, toolbars, and Liquid
  Glass. They support the system-owned direction; this report does not copy
  their code or treat their screenshots as behavioral proof.

Unavailable evidence:

- The research host has Android API 36 and an emulator toolchain. A connected
  physical Meizu device was deliberately not mutated during initial research.
- The host has only Apple Command Line Tools. Xcode, iOS SDKs, Simulator,
  signing, entitlements, and an Apple device are unavailable. The SwiftUI source
  candidate therefore is not compiled or runtime evidence. Liquid Glass,
  scroll-edge adaptation, VoiceOver, pointer, keyboard, compact/regular layout,
  and accessibility settings remain hands-on gates on an exact future candidate.
- No bridge-latency result is claimed: the debug Activity deliberately uses an
  in-process mock with the tested Rust API shape, not the future JNI/FFI seam.
  The exact arm64 debug APK is recorded below, but no size delta is claimed
  without a comparable baseline artifact; debug Rust symbols make its absolute
  size unsuitable as a release-cost estimate.

## Prototype execution evidence

The revised research Shared Rust shell authority passed all seven original
unit tests. Issue #372 later promoted that model into the production-disabled
`mish-mobile-shell` contract with broader model/property evidence. The contract
crate remains unlinked from either app.

After maintainer boundary feedback, the Android candidate removed its
Web-to-Native `JavascriptInterface`, removed Web-originated shell intents and
Rust route stacks, rebuilt through Tauri for arm64, and ran on an isolated
Android 16/API 36 emulator. The personal USB device remained untouched.

- Artifact:
  `apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- SHA-256: `abdafff9fe6026bd27c7e744102d3cd413a776f423dbf859b32c35c0402ce8ba`
- Size: 392,215,122 bytes; the artifact contains the arm64 debug Rust library
  and is not release-size evidence.
- Emulator fingerprint:
  `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`
- Native Settings selection advanced the Rust shell revision from 0 to 1 and
  emitted `/settings` into the WebView. Opening `/settings/details` through a
  Web button changed only Web-owned path/back state; the selected native tab and
  shell revision remained Settings/revision 1.
- Platform Back caused the host to query Web back availability, then sent one
  back input toward the Web route projection. The Web stack popped to
  `/settings` while the Rust shell remained revision 1 and one Activity remained.
  The next Back at Web root returned to Launcher.
- Static inspection found no `addJavascriptInterface`, `JavascriptInterface`,
  `NativeRouteBridge`, or `WKScriptMessageHandler` in either prototype. The
  closed Rust API also rejects a native-chrome attempt to open an arbitrary Web
  child path.
- Earlier geometry-only checks covered system-bar spacing, IME reveal, native
  sheet focus, light/dark, disabled state, and reduced-motion operation. Because
  those checks preceded this boundary revision, they remain supporting evidence
  and must be repeated on an accepted exact candidate before implementation.

The Android run does **not** claim hands-on proof for ripple clipping, held and
cancelled pressed state, a cancelled predictive gesture, three-button
navigation, rotation/recreation, TalkBack announcements, or Accessibility
Scanner results. Those remain explicit maintainer gates in the validation
matrix; static screenshots are only supporting evidence.

The repository's ordinary `pnpm desktop:dev` path also loaded the Browser
Client through its local Rust bridge. React Router changed `/status` to
`/routes`, marked the route heading active, and browser back returned to
`/status`. This confirms the existing desktop projection remains operational;
it does not substitute for the future installed-mobile native-to-Rust bridge.

The Apple package remains source-only. `xcodebuild` cannot run because the host
has only `/Library/Developer/CommandLineTools`; no iOS SDK or Simulator is
available. No Apple runtime or accessibility claim is made.

## Surface inventory and owner matrix

| Surface               | Shared React/CSS                                                 | Android host                                                                                     | iOS/iPadOS host                                                                              | Authority rule                                                                     |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bottom/tab navigation | Receives a one-way entry route; no shell selection backchannel   | Native Material navigation bar; rail on an accepted expanded-window slice                        | System `UITabBarController`/`TabView`; adaptable tab/sidebar on iPad                         | Selected state comes only from the Rust shell snapshot                             |
| App/navigation bar    | Product route title/actions remain inside Web content            | Native app bar only for outer-shell title/back/overflow                                          | System navigation bar and toolbar for outer-shell actions                                    | Native actions may submit shell intent; Web actions remain Web-only                |
| Drawer/sidebar        | No shell drawer implementation                                   | Native drawer only if an accepted product IA needs more than the bottom destinations             | System adaptable sidebar in regular width                                                    | Drawer/sidebar and tab bar project the same Rust shell selection                   |
| Back/edge gesture     | React Router owns internal history, back, preview, and DOM focus | Host delegates to WebView history while available; root back remains system-owned                | Host delegates inner back to the single WKWebView; no native product-route stack             | Rust never mirrors internal Web back state                                         |
| Sheets                | Product forms, choices, validation, and route sheets remain Web  | Native sheet only when launched by native chrome for a bounded platform concern                  | Same; native-origin platform presentation only                                               | Web content cannot request a Native sheet                                          |
| Safe area             | Content consumes only unhandled insets                           | Host consumes bars/cutout for native chrome and zeroes handled values before WebView             | System containers own bars/home indicator; Web content receives its remaining safe area      | Never pad the same inset in native and CSS                                         |
| Keyboard/insets       | Visual viewport, field scroll, validation                        | `adjustResize` plus IME insets; do not clear Web focus on viewport changes                       | System keyboard avoidance; verify iPhone and iPad floating/docked keyboards                  | Web focus survives resize; keyboard does not mutate shell selection                |
| Focus                 | Owns DOM focus and Web sheet return targets                      | Native focus stays within shell; WebView regains ordinary host focus after native dismissal      | Native focus stays within shell; WKWebView owns content focus                                | No cross-boundary focus token or DOM selector                                      |
| Pressed feedback      | Content controls only                                            | Material state layer/ripple for chrome; clip belongs to the item/indicator, not the complete bar | System touch-down/highlight behavior                                                         | Pressed state is local and may precede authority commit; selected state may not    |
| Motion                | Page/content motion with reduced-motion fallback                 | Material shell motion and predictive progress; no custom gesture conflict                        | System shell/tab motion and Liquid Glass response                                            | Gesture progress is presentation-only; the owning Web or shell domain commits once |
| Split view            | Owns product list/detail routing inside WebView                  | Native rail/drawer may adapt around the same one WebView                                         | System shell sidebar may adapt around the same one WKWebView                                 | Adaptation changes shell chrome, not Web history                                   |
| Accessibility         | Accessible names, content semantics, DOM reading order/focus     | Material shell semantics, TalkBack, switch/keyboard focus, 48dp chrome targets                   | Dynamic Type, VoiceOver, Full Keyboard Access, pointer, Reduce Motion/Transparency for shell | Native and Web own disjoint trees; neither invokes the other                       |

## One writer per navigation domain

### Shared Rust shell state

The process-scoped Shared Rust authority contains only outer-shell state. It
contains no Profile, capture, Core, Settings, notification, Web history, Web
back, or DOM-focus state.

```text
ShellSnapshot =
  authorityId
  + revision
  + selectedTab
  + webEntryPath
```

Its closed input set is:

```text
ShellIntent =
  intentId
  + source(androidChrome | appleChrome | platformDeepLink)
  + expectedRevision
  + selectTab | openExternalPath
```

There is intentionally no React/Web source, `back` intent, per-tab stack,
`canGoBack`, focus token, native-component command, or general-purpose bridge.
Chrome may select only a declared top-level destination. A platform deep link
may select its matching shell destination and forward the full path once as the
Web entry directive. Stale, duplicate, invalid, or source/action-mismatched
intents do not mutate the shell.

The production-disabled crate at
[`crates/mobile-shell`](../../crates/mobile-shell) proves these closed inputs,
top-level mapping, one-way entry reset, external deep-link forwarding,
stale/duplicate rejection, prepare/commit revalidation, and invalid-input
non-mutation without selecting a production shell.

### React Router Web state

React Router remains the sole writer for everything inside the WebView:

- `Link`/`NavLink` provide ordinary accessible Web navigation;
- `navigate` remains reserved for imperative Web redirects;
- browser history, child routes, search parameters, page sheets, pending state,
  and DOM focus never enter the Rust shell snapshot; and
- installed-mobile Web links stay inside the selected top-level section. A
  cross-section destination must be exposed in native tab/drawer chrome or
  arrive as a platform deep link, not as a Web-to-Native request.

The host may deliver an accepted `webEntryPath` into React Router through a
one-way injection or host-owned event. The Web bundle exposes no
`JavascriptInterface`, `WKScriptMessageHandler`, Tauri invoke command, custom
URL scheme, or callback that can request a native tab, drawer, sheet, haptic,
permission, or route mutation. Product data commands already owned by Shared
Rust are a separate audited application boundary; they must not become a
generic Native-UI escape hatch.

### Back, focus, lifecycle, and deep links

- Internal route/back/focus is a Web concern. The host queries Web-owned back
  availability and sends a back input toward Web while history exists. At the
  Web root, the host exits through the platform Activity/controller path without
  a Rust shell transition.
- Predictive/interactive progress may be presented toward the WebView, but
  cancellation and completion cannot mutate Rust shell selection. Native must
  not maintain a parallel internal route stack.
- Activity/ViewController recreation requests the complete Rust shell snapshot,
  then emits its `webEntryPath` once into the single WebView. React restores its
  own internal state using Web-owned mechanisms.
- Android `onNewIntent` and the Apple scene/open-URL path submit a platform
  deep-link intent to Rust. The accepted shell selection and full entry path are
  delivered toward Web; Web never reports later internal navigation back.
- Native pressed/ripple/highlight remains local. Selected shell chrome changes
  only after the Rust revision commits. Web route focus is moved by React Router
  after it consumes the one-way entry directive.

## Android expectations and candidate

### Required behavior

| Concern                   | Required Android behavior                                                                                                                                    | Candidate evidence/gate                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Navigation bar            | Three to five equal destinations, visible labels, Material indicator and state layer                                                                         | Debug `BottomNavigationView` has five labeled items and snapshot-driven selection                       |
| Ripple                    | Origin follows touch; state layer/ripple is clipped to the Material item/indicator, not a rectangular Web child or structurally clipped bar                  | Record slow taps at each icon edge and inspect no bleed/cutoff                                          |
| Selected/pressed/disabled | Pressed is immediate; selected waits for snapshot; disabled is non-actionable and exposed as disabled to accessibility                                       | Prototype toggles Profiles enabled state and keeps selection authority separate                         |
| App bar                   | System density and shell-level title/overflow with at least 48dp targets; Web route title remains in Web content                                             | Debug `MaterialToolbar` projects only the selected shell destination                                    |
| Back                      | API 34+ progress is visible; cancellation is lossless; completion delegates once to Web history; Web root transitions to system home                         | Prototype queries Web-owned back availability, sends one back input toward Web, and has no Rust stack   |
| Insets                    | Edge-to-edge; host applies bar/cutout insets to native chrome and zeroes only handled types before WebView; IME remains dispatched                           | Rotate, switch gesture/three-button navigation, and focus the keyboard probe                            |
| Motion                    | Material/system motion when animators are enabled; no custom route transform when system animation scale is zero                                             | Prototype gates predictive preview with `ValueAnimator.areAnimatorsEnabled()`                           |
| Appearance                | Material semantic colors and system light/dark icon contrast; Mish status colors remain product content tokens                                               | Toggle appearance and inspect chrome/content separately                                                 |
| Accessibility             | Labeled items, selected and disabled states, logical order, 48dp targets, TalkBack/keyboard operability                                                      | Accessibility Scanner plus TalkBack manual traversal; UIAutomator hierarchy is supporting evidence only |
| Haptics                   | Routine navigation does not add gratuitous vibration; committed high-value actions may use action-oriented platform constants and must honor system settings | No custom vibration in the shell prototype; any future command haptic is separately accepted            |
| Sheets                    | Native Material sheet only for a native-origin bounded platform concern; Web product sheets remain Web and cannot request Native                             | Prototype sheet is reachable only from the native toolbar and exposes no Web bridge                     |
| Expanded windows          | Navigation rail, not desktop sidebar, after an explicit foldable/tablet candidate                                                                            | Not implemented in this phone prototype; official adaptive navigation remains direction evidence        |

The Android candidate was debug-only and excluded from release source sets.
Issue #373 later removed that second-Activity prototype when
[`InstalledAndroidShellHost.kt`](../../apps/mobile/src-tauri/gen/android/app/src/main/java/com/asuka109/mish/InstalledAndroidShellHost.kt)
cut the accepted Material projection into `MainActivity` around the retained
Tauri WebView. The app's existing Material dependency supplies the native
components, so neither candidate adds a UI runtime library.

### Android ownership recommendation

Accept **selective native Material Views** for persistent bottom navigation,
top app bar, system insets, and predictive-back integration.

Keep in React:

- all product page bodies and Shared Rust product projections;
- Activity secondary navigation until a complete adaptive pane is accepted;
- complex or validation-heavy sheets and child routes;
- search/filter presentation, pending affordances, internal history/back, and DOM focus targets; and
- Mish design tokens for content, semantic statuses, and data typography.

Keep native:

- navigation bar/rail geometry, ripple, state layer, touch target, and TalkBack
  semantics;
- top app bar geometry and platform back/overflow affordances;
- system bar, display cutout, and keyboard-inset composition at the WebView
  boundary;
- predictive-back progress/cancel callbacks and delegation into Web history;
- top-level shell selection projected from Shared Rust; and
- native-origin platform sheets and restrained platform haptics where
  separately accepted.

The native host must not expose a general Web-to-Native bridge. In particular,
Web content cannot select a native destination, open native presentation, or
request shell back/focus. Cross-section Web links are excluded from the mobile
composition; the native tab/drawer is the only user-facing primary switcher.

Do not add Compose solely for these bars. Compose would add a second rendering
tree plus Compose runtime, Material 3, navigation/adaptive, compiler, lifecycle,
and testing surfaces. It becomes preferable only when an accepted native screen
or adaptive list/detail flow can amortize that cost. MUI is rejected: it adds a
second Web design system, does not fix Tauri/WebView back or inset ownership, and
is not an iOS answer.

## iOS and iPadOS expectations and candidate

### Required behavior

| Concern               | Required Apple behavior                                                                                                                                         | Candidate evidence/gate                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Tabs                  | System tab bar on compact iPhone; platform-appropriate top tab/sidebar adaptation on iPad; five stable product tabs                                             | SwiftUI prototype uses `TabView` and `.sidebarAdaptable`                                       |
| Navigation            | Native navigation container owns outer-shell title/toolbar only; React Router owns product route stack and internal back                                        | Source candidate has no native child stack; runtime proof unavailable                          |
| Liquid Glass/material | Standard tabs, bars, toolbars, and sidebars adopt system Liquid Glass and accessibility variants; content uses standard material only where semantically useful | No CSS imitation; requires iOS/iPadOS 26 runtime inspection                                    |
| Scroll edge           | Scrolling content extends under system chrome where appropriate; system controls legibility and tab minimization                                                | Candidate has long system scroll content and tab minimize-on-scroll; runtime proof unavailable |
| Sheets                | System sheet/popover only for a native-origin bounded platform concern; Web product sheets remain internal and cannot request Native                            | Candidate diagnostic sheet is launched only by native toolbar; runtime proof unavailable       |
| Safe area/keyboard    | System containers own bars, home indicator, keyboard avoidance, rotation, Stage Manager, and multitasking                                                       | Phone/iPad portrait/landscape and floating/docked keyboard are required gates                  |
| Dynamic Type          | Semantic system fonts reflow through accessibility sizes without clipped tab labels, toolbar actions, or sheet rows                                             | Candidate uses semantic fonts and `ViewThatFits`; Accessibility Inspector required             |
| VoiceOver             | System shell traits/order/selection are native; Web heading/focus order remains wholly inside WKWebView                                                         | No cross-boundary focus token; real VoiceOver required                                         |
| Reduce Motion         | System transitions adapt; custom content replaces spatial movement with a fade or no motion                                                                     | Candidate reads `accessibilityReduceMotion`; real setting required                             |
| Reduce Transparency   | System Liquid Glass adapts; custom material becomes opaque where needed                                                                                         | Candidate reads `accessibilityReduceTransparency`; real setting required                       |
| Pointer/keyboard      | iPad pointer hover, Full Keyboard Access, and non-conflicting shortcuts                                                                                         | Candidate uses hover effects and scoped shortcuts; real hardware/simulator required            |
| Compact/regular       | Compact remains tab-first; regular may expose adaptable sidebar or split view without desktop sidebar reuse                                                     | iPhone and iPad/Stage Manager walkthrough required                                             |

The source-ready Apple candidate is
[`MishShellPrototype.swiftpm`](../../prototypes/mobile-shell/ios/MishShellPrototype.swiftpm/Package.swift).
It uses system SwiftUI shell components around an explicit single-WKWebView
boundary placeholder. It does not implement native product content or a native
child route stack. It is not linked into Tauri and was not compiled because the
host has no Xcode or iOS SDK.

### Why Liquid Glass cannot be a Web/CSS component

System Liquid Glass is not a fixed blur recipe. The platform owns background
sampling, luminosity and legibility adjustment, functional-layer separation,
scroll-edge effects, touch-versus-pointer response, control grouping, compact
and regular adaptation, and changes caused by Reduce Transparency, increased
contrast, Reduce Motion, OS appearance, and future SDK behavior.

CSS `backdrop-filter`, gradients, and captured backgrounds cannot provide that
contract. They cannot turn a five-item iPhone tab bar into the current iPad tab
or sidebar behavior, participate in `UITabBarController` scroll-edge semantics,
inherit future system hit testing and animation changes, or prove equivalent
VoiceOver and Full Keyboard Access behavior. A decorative approximation may be
acceptable for Web content material, but not for system navigation chrome.

Therefore system tabs, navigation bars, sidebars/split views, and short sheets
are native-owned on Apple platforms. If the required native host container
cannot be delivered, the honest result is that the iOS installed-app shell is
not ready; a custom CSS glass bar is not the fallback.

### SwiftUI versus UIKit recommendation

SwiftUI is the preferred behavior description for the Apple outer shell: it
provides concise system tabs, shell navigation/toolbars, native-origin sheets,
Dynamic Type, accessibility environments, and adaptive sidebar behavior. The
prototype uses it for those reasons and deliberately leaves product content as
a one-WebView boundary placeholder.

For Mish's current Tauri boundary, UIKit is the lower-risk host integration
candidate because Tauri exposes an existing `UIViewController` and `WKWebView`.
The bounded production exploration should test a UIKit
`UITabBarController`/`UINavigationController` container that reparents one
WKWebView projection, or a `UIHostingController` wrapper around the same single
WKWebView. Five independent WebViews are rejected because they multiply memory,
Tauri lifecycle, product subscriptions, focus, cookies/storage, and testing.

No UIKit or SwiftUI production choice is accepted until an iOS host prototype
proves one WebView, one Rust shell authority, one React Router Web authority,
no Web-to-Native command channel, correct controller containment, system-back
delegation, deep links, accessibility separation, and Tauri plugin lifecycle.

## Option comparison

| Direction                        | Fidelity                                                                       | Bundle/runtime cost                                                                       | Token reuse                                   | Lifecycle and bridge                                                                | Testing/a11y                                            | Future API change                                               | Decision                                                               |
| -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Shared React/CSS chrome          | Medium on Android content; low for Android ripple/back and Apple system chrome | Lowest new native code; existing Web runtime                                              | Highest direct CSS token reuse                | Simple React lifecycle, but WebView/system gesture and inset boundaries remain      | Good DOM tests; cannot prove native system semantics    | Custom code must chase both platforms                           | Keep for product content, not persistent installed-mobile chrome       |
| Selective Web library            | Potential Android visuals only; no Apple system fidelity                       | Adds JS/CSS/runtime and a second design-system surface                                    | Token mapping required and may drift          | Does not solve native back, safe area, keyboard, or host lifecycle                  | Library DOM semantics, still not native                 | Library and OS both change                                      | Reject MUI/new dependency for this task                                |
| Selective Android Material Views | High for Android bars/ripple/semantics with existing dependency                | Small host code; zero new library in current APK; measured delta pending                  | Map stable Mish semantic colors, not geometry | One Activity/WebView boundary; native back and insets are explicit                  | Espresso/UIAutomator/TalkBack plus Web tests            | Material library/API updates are localized                      | Recommended Android first slice                                        |
| Jetpack Compose native shell     | Highest Android consistency and adaptive APIs                                  | Adds Compose runtime/compiler/Material/adaptive stack unless later native UI amortizes it | Requires a Kotlin token adapter               | Compose + WebView interop and two rendering trees; strong native navigation APIs    | Excellent semantics/test APIs; more test infrastructure | Google system APIs evolve coherently                            | Defer until a complete native screen/pane is accepted                  |
| SwiftUI native shell             | Highest concise Apple system behavior                                          | OS framework plus host code; one-WKWebView constraint still matters                       | Swift color/status adapter                    | Clean state binding, but Tauri root-controller integration is unproven              | Strong Dynamic Type/environment support; Xcode required | Standard components inherit new Apple behavior                  | Preferred Apple behavior prototype; production integration conditional |
| UIKit native shell               | Highest Apple behavior with explicit controller control                        | More host code, no third-party UI runtime                                                 | UIKit semantic color adapter                  | Best fit for existing Tauri controller/WKWebView; containment complexity is visible | XCTest/Accessibility Inspector and delegate tests       | Standard bars inherit platform behavior; more manual adaptation | Recommended Apple host integration candidate                           |

Bundle size, memory, startup, and bridge latency must be measured from exact
candidate artifacts. The decision must not use ecosystem reputation or an
unrelated app's package size as Mish evidence.

## Tauri composition boundary

Tauri remains transport and WebView infrastructure, not a generic Native UI
bridge. Shared Rust owns the outer-shell selection; React Router owns internal
Web navigation.

Android:

- Keep `TauriActivity` and the one Tauri WebView.
- Add native chrome through an accepted host adapter or Activity layout, not a
  plugin-owned product store.
- Kotlin sends only closed native-chrome/platform-deep-link shell intents to
  Shared Rust, then delivers the accepted `webEntryPath` one-way toward React.
- Do not install `addJavascriptInterface`, a custom URL handler, or a Web-facing
  Tauri command for tabs, drawers, native sheets, haptics, permissions, or back.
- Register one back listener. Delegate to WebView history while available and
  leave Web-root exit to the system; do not create a Rust/native product stack.
- Use the documented WebView inset zeroing pattern after native chrome consumes
  system bars and cutouts; keep IME updates flowing.
- Kotlin invokes the Rust shell authority through a bounded JNI/FFI seam,
  matching Mish's existing mobile pattern. It publishes only accepted shell
  snapshots toward native chrome and one-way Web entry directives.

Apple:

- Keep one Tauri `WKWebView` and one mobile Rust shell authority.
- Use the WebView/controller hook only inside a bounded host adapter. Do not
  infer that Tauri supports arbitrary root-controller replacement because a
  pointer is exposed.
- UIKit/SwiftUI sends closed shell intents through FFI and renders shell
  snapshots. The host emits an accepted entry path toward the WKWebView but
  installs no `WKScriptMessageHandler` or Web-facing native command channel.
- Product-route back, sheets, state, and focus remain in React Router/Web
  content. UIKit delegates to WKWebView history and does not mirror it.
- The WebView remains a content projection and must not be replicated once per
  tab.

Bridge timing policy:

- Touch-down/ripple/highlight and predictive gesture progress stay local to the
  native presentation for frame-rate responsiveness.
- Selected tab and outer-shell title update only on the accepted Rust snapshot.
  Internal route title, back availability, pending state, and focus remain Web.
- Instrument native-intent-to-Rust, Rust transition, Rust-to-native render, and
  one-way Rust-to-Web entry delivery separately. No Web-to-Native latency path
  exists because no such UI bridge is permitted.

## Reversible migration sequence

These are bounded draft slices, not created Issues.

1. **Common shell contract.** Land the mobile-only Shared Rust shell reducer,
   closed native/deep-link intent schema, stale/duplicate/source/path tests, and
   one-way Web entry fixture. Add a negative check that no Web-to-Native shell
   command or script handler exists. Keep the current product shell selected by
   default.
2. **Android debug comparison.** Add a build-time debug candidate that renders
   native Material bars around the unchanged WebView. Compare CSS and native
   candidates on the same #324 Home baseline. Removing the debug flag restores
   the current shell.
3. **Android installed-mobile cutover.** After acceptance, remove persistent Web
   chrome only from the Android production composition and enable the native
   projection. Desktop, Browser Client, and iOS remain unchanged.
4. **Apple host baseline.** With Xcode available, generate and freeze the Tauri
   iOS host, then prove one WKWebView inside UIKit and SwiftUI candidates without
   Packet Tunnel or product behavior.
5. **Apple system-chrome comparison.** Run exact iPhone/iPad compact/regular,
   Liquid Glass, accessibility, pointer/keyboard, deep-link, Web-back, and
   lifecycle comparisons. Reject the architecture if single-WebView containment,
   disjoint shell/Web writers, or absence of a Web-to-Native channel cannot be
   proven.
6. **Apple installed-mobile cutover.** Only after hands-on acceptance, enable
   system tabs/navigation for iOS/iPadOS behind a reversible build-time boundary.

Each slice has one observable platform outcome and preserves desktop/browser
behavior. Follow-up Issues may be created only for the accepted slices and must
retain explicit platform dependencies.

After the 2026-08-04 acceptance, the bounded next slices were published as
#372 (Shared Rust shell contract), #373 (Android installed-mobile cutover), and
#374 (Apple single-WebView host/runtime comparison). The Apple production
cutover remains intentionally uncreated until #374 supplies exact Xcode/runtime
evidence and receives its own hands-on acceptance.

## Acceptance decision

The maintainer must accept or reject Android and Apple independently.

| Platform   | Hands-on decision surface                                                                                                                                                                                                       | Acceptance signal                                                                                                                            | Current state                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Android    | Exact debug APK: native vs current React bars, strict one-way boundary, ripple clipping, selected/pressed/disabled, delegated Web back/root exit, insets/IME, TalkBack, light/dark, reduced motion, native-origin sheet         | Explicitly accept selective Material Views plus disjoint shell/Web writers and no Web-to-Native bridge, or reject with the observed mismatch | Accepted 2026-08-04; residual exact-candidate hands-on gates transfer to the Android implementation Issue                      |
| iOS/iPadOS | Exact Xcode candidate on iPhone and iPad: system shell tabs/navigation, one WKWebView, no Web backchannel, Liquid Glass, Dynamic Type, VoiceOver, accessibility settings, pointer/keyboard, compact/regular, deep-link/Web-back | Explicitly accept UIKit/SwiftUI host direction plus the strict one-way boundary, or reject with the observed mismatch                        | Architecture direction accepted 2026-08-04; Xcode/runtime evidence remains unavailable and must precede any production cutover |

The maintainer's 2026-08-04 acceptance satisfies the research decision gate for
both platforms. It does not waive the unavailable Apple runtime evidence or the
hands-on gates attached to the bounded follow-up Issues.

## Official sources

Android:

- [Navigation bar](https://developer.android.com/develop/ui/compose/components/navigation-bar)
- [Material 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3)
- [Build adaptive navigation](https://developer.android.com/develop/adaptive-apps/guides/build-adaptive-navigation)
- [Material 3 insets](https://developer.android.com/develop/ui/compose/system/material-insets)
- [Views edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [WebView window insets](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)
- [Software keyboard and insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard)
- [Predictive back](https://developer.android.com/develop/ui/compose/system/predictive-back)
- [Accessibility semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics)
- [Accessibility testing](https://developer.android.com/develop/ui/compose/accessibility/testing)
- [Haptic feedback](https://developer.android.com/develop/ui/views/haptics/haptic-feedback)
- [`ValueAnimator.areAnimatorsEnabled`](https://developer.android.com/reference/android/animation/ValueAnimator#areAnimatorsEnabled%28%29)

Apple:

- [Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Human Interface Guidelines: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Human Interface Guidelines: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [SwiftUI navigation](https://developer.apple.com/documentation/swiftui/navigation)
- [Enhancing content with tab navigation](https://developer.apple.com/documentation/swiftui/enhancing-your-app-content-with-tab-navigation)
- [Navigation split view adoption](https://developer.apple.com/documentation/technotes/tn3154-adopting-swiftui-navigation-split-view)
- [SwiftUI presentation modifiers](https://developer.apple.com/documentation/SwiftUI/View-Presentation)
- [Dynamic Type environment](https://developer.apple.com/documentation/swiftui/environmentvalues/dynamictypesize)
- [Reduce Motion environment](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion)
- [Reduce Transparency environment](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducetransparency)
- [UIKit iPad tab bar and sidebar](https://developer.apple.com/documentation/uikit/elevating-your-ipad-app-with-a-tab-bar-and-sidebar)
- [UIKit navigation-bar appearance and scroll edge](https://developer.apple.com/documentation/technotes/tn3106-customizing-uinavigationbar-appearance)

Tauri and implementation sources:

- [Tauri mobile plugin development](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [Tauri Android app-plugin back implementation](https://github.com/tauri-apps/tauri/blob/020919a1b5d2c1faa9deb972a31a1a11d0ae8ce6/crates/tauri/mobile/android/src/main/java/app/tauri/AppPlugin.kt)
- [Tauri Android Activity lifecycle](https://github.com/tauri-apps/tauri/blob/020919a1b5d2c1faa9deb972a31a1a11d0ae8ce6/crates/tauri/mobile/android-codegen/TauriActivity.kt)
- [Tauri iOS WebView/controller hook](https://github.com/tauri-apps/tauri/blob/020919a1b5d2c1faa9deb972a31a1a11d0ae8ce6/crates/tauri/mobile/ios-api/Sources/Tauri/Tauri.swift)
- [Now in Android navigation composition](https://github.com/android/nowinandroid/blob/7d45eae4f8720a0c77f507712ba2437ff974b6ed/app/src/main/kotlin/com/google/samples/apps/nowinandroid/ui/NiaApp.kt)
- [Now in Android Material navigation wrapper](https://github.com/android/nowinandroid/blob/7d45eae4f8720a0c77f507712ba2437ff974b6ed/core/designsystem/src/main/kotlin/com/google/samples/apps/nowinandroid/core/designsystem/component/Navigation.kt)
