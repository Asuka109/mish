# Mobile Native Shell Ownership Research

## Decision status

This report is the Issue #343 architecture candidate. It does not authorize a
mobile-shell rewrite. No product shell, runtime dependency, or product behavior
changes in this pull request. The Android and Apple candidates are research-only
prototypes, and the exact follow-up slices remain drafts until a maintainer
accepts or rejects this matrix through the required hands-on review.

The recommended installed-mobile boundary is:

- Shared Rust remains the only product authority for Profiles, capture, Core,
  Routes, Traffic, Events, Settings, notifications, ordering, and recovery.
- One small Shared Rust **mobile navigation authority** becomes the only owner of
  installed-mobile tab selection and per-tab route stacks. This is a deliberate
  exception to the current React-owned navigation contract because native chrome
  and the WebView would otherwise each require a mutable navigation stack.
- Android and Apple native chrome submit navigation intents and render complete
  revisioned navigation snapshots. They do not keep an independent selected-tab
  or route store.
- React Router becomes an installed-mobile projection and intent source. It does
  not commit browser history before the navigation authority accepts an intent.
  Desktop and Browser Client keep their existing React Router authority and are
  unaffected.
- Android initially uses selective Material Views already present in the APK,
  not Compose or MUI, for the persistent navigation and app bars. Compose becomes
  worthwhile only if a later accepted slice moves a complete native screen or
  adaptive pane into Android UI.
- iOS and iPadOS use system-owned tabs, navigation bars/stacks, sheets, materials,
  and adaptive sidebar or split-view behavior. UIKit is the production host
  integration candidate around Tauri's `WKWebView`; SwiftUI is the concise
  behavior prototype and remains an option after the iOS host boundary exists.

This proposal supersedes the installed-mobile portion of the current statement
that React Router is always the navigation authority. It must not replace that
contract until the maintainer accepts this report and a bounded implementation
Issue changes the architecture and validation documents together.

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
  navigation implementation must replace that default with one authority-backed
  callback or it can double-pop React and native history.
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

The Shared Rust authority candidate passed all five unit tests with
`cargo test -p mish-mobile-navigation-prototype`. The tests are state-contract
evidence only; the prototype crate is not linked into either app.

The final Android source candidate compiled through Tauri for arm64 and ran on
an isolated Android 16/API 36 emulator. The personal USB device remained
untouched.

- Artifact:
  `apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- SHA-256: `144b3919162b598bedafca98ccb3b1b8debd6bdb7dcc7ae9942e11d5b2b4e49d`
- Size: 204,771,778 bytes; the artifact contains the arm64 debug Rust library
  and is not release-size evidence.
- Emulator fingerprint:
  `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`
- Native tab selection advanced one revision and projected the same selected
  item and Web route. A Web child advanced the next revision and focused the
  route heading. An injected API 36 edge gesture popped once, advanced one
  revision, and left one Activity. At the tab root the prototype unregistered
  its consuming callback; the next edge gesture was handled by the system and
  returned to Launcher.
- `/settings/network` delivered through `onNewIntent` to the existing
  `singleTop` Activity, advanced one revision, selected Settings, projected the
  same Web route, and left one Activity. Disabling Profiles exposed
  `enabled=false`; tapping it did not change the selected Settings tab or route
  revision.
- The system-bar spacer kept all five labels above the gesture handle. The IME
  became visible, the focused Web field scrolled fully above it, and the native
  navigation returned unchanged on dismissal. The native sheet exposed enabled
  and disabled rows; dismissal restored focus to the route heading without a
  route revision.
- Light and dark candidates rendered with matching system-bar contrast. Setting
  the emulator animator duration scale to zero projected `reduced motion` and
  kept navigation operational; the effective scale and light appearance were
  restored before cleanup.

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

| Surface               | Shared React/CSS                                                | Android host                                                                                     | iOS/iPadOS host                                                                                 | Authority rule                                                                      |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Bottom/tab navigation | Product labels and route intent hook only                       | Native Material navigation bar; rail on an accepted expanded-window slice                        | System `UITabBarController`/`TabView`; adaptable tab/sidebar on iPad                            | Selected state comes only from the Rust navigation snapshot                         |
| App/navigation bar    | Route metadata and scoped action descriptors                    | Native Material top app bar for title/back/overflow                                              | System navigation bar and toolbar                                                               | Native actions submit intent/command; no native route store                         |
| Drawer/sidebar        | No phone drawer                                                 | No drawer for five phone destinations; future rail at expanded widths                            | System adaptable sidebar or split view in regular width                                         | Same tab/route snapshot drives every form factor                                    |
| Back/edge gesture     | Renders preview and restores DOM focus                          | Platform predictive-back callback previews locally and commits one revisioned back intent        | System interactive pop drives one authority intent; native stack is rebuilt from full snapshots | Back cannot call both WebView history and native history                            |
| Sheets                | Complex validation and product forms remain React routes/sheets | Native bottom sheet only for short platform choices or permission-adjacent UI                    | System sheets/popovers with detents for short choices                                           | Open/closed sheet state stays presentation-local; route changes still use authority |
| Safe area             | Content consumes only unhandled insets                          | Host consumes bars/cutout for native chrome and zeroes handled values before WebView             | System containers own bars/home indicator; Web content receives its remaining safe area         | Never pad the same inset in native and CSS                                          |
| Keyboard/insets       | Visual viewport, field scroll, validation                       | `adjustResize` plus IME insets; do not clear focus on viewport changes                           | System keyboard avoidance; verify iPhone and iPad floating/docked keyboards                     | Focus token survives resize; keyboard does not mutate route                         |
| Focus                 | DOM focus target and return target                              | Native-to-Web focus handoff after snapshot/sheet dismissal                                       | VoiceOver/keyboard focus handoff after snapshot/sheet dismissal                                 | Snapshot carries monotonic focus token, not a native DOM selector                   |
| Pressed feedback      | Content controls only                                           | Material state layer/ripple for chrome; clip belongs to the item/indicator, not the complete bar | System touch-down/highlight behavior                                                            | Pressed state is local and may precede authority commit; selected state may not     |
| Motion                | Page/content motion with reduced-motion fallback                | Material motion and predictive progress; no custom gesture conflict                              | System navigation/sheet/tab motion and Liquid Glass response                                    | Gesture progress is presentation-only; commit is one authority transition           |
| Split view            | Dense product content can provide shared detail models          | Future adaptive list/detail after phone acceptance                                               | System split view/sidebar in regular width                                                      | Collapsing/expanding projects the same route stack                                  |
| Accessibility         | Accessible names, content semantics, DOM reading order          | Material semantics, TalkBack, switch/keyboard focus, 48dp chrome targets                         | Dynamic Type, VoiceOver, Full Keyboard Access, pointer, Reduce Motion/Transparency              | Native and Web each own their tree; handoff is explicit and testable                |

## One navigation authority

### Canonical state

The proposed navigation authority is process-scoped and presentation-only. It
contains no Profile, capture, Core, Settings, or notification product data.

```text
NavigationSnapshot =
  authorityId
  + revision
  + selectedTab
  + five bounded tabStacks
  + activePath
  + canGoBack
  + focusToken
```

Every input is an intent:

```text
NavigationIntent =
  intentId
  + source(android | apple | react | deep-link | platform-back)
  + expectedRevision
  + openPath | selectTab | back
```

The authority accepts one current revision, retires duplicate intent IDs, maps
desktop-compatible deep links to the five mobile tabs, commits one revision,
and publishes one complete snapshot. A stale or invalid intent returns the
current snapshot without changing route or focus.

The research crate at
[`prototypes/mobile-shell/navigation-authority`](../../prototypes/mobile-shell/navigation-authority)
proves:

- native and React intents converge on the same selected tab and route stack;
- `/traffic` and `/events` select Activity, while child Settings and Routes
  links preserve the other tab stacks;
- platform back pops within the current tab before requesting application exit;
- stale and duplicate intents cannot replace the current native or React
  projection; and
- rejected deep links do not advance route revision or focus.

### React Router projection

Installed mobile must wrap `Link`, `NavLink`, `navigate`, deep-link handling,
and notification navigation behind one `MobileNavigationClient`:

1. React submits an intent and keeps only pending presentation.
2. Rust returns or emits a complete snapshot.
3. React applies the active path to a controlled memory router or performs a
   replace-only history projection. It never adds an independent browser entry.
4. The native shell renders the same snapshot revision.
5. React moves focus to the route heading only when the focus token advances and
   acknowledges the handoff for diagnostics.

`window.history.back()`, Tauri's default `WebView.goBack()`, and a native stack
pop are forbidden as independent commit paths. A platform gesture may preview
the current snapshot locally; cancellation changes nothing, and completion
submits exactly one `back` intent with the gesture-start revision.

### Lifecycle and deep links

- Activity/ViewController recreation requests the complete Rust snapshot before
  accepting later events. Native saved state may retain only a last-observed
  revision for diagnostics, never a reconstructable route authority.
- Process replacement creates a new authority ID. The platform supplies the
  launch/deep-link path once; absent a link, Rust starts at Home.
- Android `onNewIntent` and the Apple scene/open-URL path submit a deep-link
  intent. Neither writes React history directly.
- A native tab or bar may display touch-down immediately. Selected chrome changes
  only after the accepted snapshot, preventing fast double taps or bridge delay
  from showing content and tab selection from different revisions.

## Android expectations and candidate

### Required behavior

| Concern                   | Required Android behavior                                                                                                                                    | Candidate evidence/gate                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Navigation bar            | Three to five equal destinations, visible labels, Material indicator and state layer                                                                         | Debug `BottomNavigationView` has five labeled items and snapshot-driven selection                       |
| Ripple                    | Origin follows touch; state layer/ripple is clipped to the Material item/indicator, not a rectangular Web child or structurally clipped bar                  | Record slow taps at each icon edge and inspect no bleed/cutoff                                          |
| Selected/pressed/disabled | Pressed is immediate; selected waits for snapshot; disabled is non-actionable and exposed as disabled to accessibility                                       | Prototype toggles Profiles enabled state and keeps selection authority separate                         |
| App bar                   | System density/title/back/overflow with at least 48dp targets                                                                                                | Debug `MaterialToolbar` projects title and `canGoBack`                                                  |
| Back                      | API 34+ progress is visible; cancellation is lossless; completion sends one expected-revision back; root transitions to system home                          | Prototype uses `OnBackAnimationCallback`; fallback uses `OnBackPressedDispatcher`                       |
| Insets                    | Edge-to-edge; host applies bar/cutout insets to native chrome and zeroes only handled types before WebView; IME remains dispatched                           | Rotate, switch gesture/three-button navigation, and focus the keyboard probe                            |
| Motion                    | Material/system motion when animators are enabled; no custom route transform when system animation scale is zero                                             | Prototype gates predictive preview with `ValueAnimator.areAnimatorsEnabled()`                           |
| Appearance                | Material semantic colors and system light/dark icon contrast; Mish status colors remain product content tokens                                               | Toggle appearance and inspect chrome/content separately                                                 |
| Accessibility             | Labeled items, selected and disabled states, logical order, 48dp targets, TalkBack/keyboard operability                                                      | Accessibility Scanner plus TalkBack manual traversal; UIAutomator hierarchy is supporting evidence only |
| Haptics                   | Routine navigation does not add gratuitous vibration; committed high-value actions may use action-oriented platform constants and must honor system settings | No custom vibration in the shell prototype; any future command haptic is separately accepted            |
| Sheets                    | Native Material sheet only for short bounded platform choices; focus returns to the route heading                                                            | Prototype native sheet includes enabled and disabled rows and explicit focus restoration                |
| Expanded windows          | Navigation rail, not desktop sidebar, after an explicit foldable/tablet candidate                                                                            | Not implemented in this phone prototype; official adaptive navigation remains direction evidence        |

The runnable Android candidate is debug-only:
[`ShellPrototypeActivity.kt`](../../apps/mobile/src-tauri/gen/android/app/src/debug/java/com/asuka109/mish/ShellPrototypeActivity.kt).
It is excluded from release source sets and does not replace `MainActivity` or
the React product shell. The app's existing Material dependency supplies the
native components, so this candidate adds no runtime library.

### Android ownership recommendation

Accept **selective native Material Views** for persistent bottom navigation,
top app bar, system insets, and predictive-back integration.

Keep in React:

- all product page bodies and Shared Rust product projections;
- Activity secondary navigation until a complete adaptive pane is accepted;
- complex or validation-heavy sheets and child routes;
- search/filter presentation, pending affordances, and DOM focus targets; and
- Mish design tokens for content, semantic statuses, and data typography.

Keep native:

- navigation bar/rail geometry, ripple, state layer, touch target, and TalkBack
  semantics;
- top app bar geometry and platform back/overflow affordances;
- system bar, display cutout, and keyboard-inset composition at the WebView
  boundary;
- predictive-back progress/cancel callbacks; and
- short platform sheets and restrained platform haptics where appropriate.

Do not add Compose solely for these bars. Compose would add a second rendering
tree plus Compose runtime, Material 3, navigation/adaptive, compiler, lifecycle,
and testing surfaces. It becomes preferable only when an accepted native screen
or adaptive list/detail flow can amortize that cost. MUI is rejected: it adds a
second Web design system, does not fix Tauri/WebView back or inset ownership, and
is not an iOS answer.

## iOS and iPadOS expectations and candidate

### Required behavior

| Concern               | Required Apple behavior                                                                                                                                         | Candidate evidence/gate                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tabs                  | System tab bar on compact iPhone; platform-appropriate top tab/sidebar adaptation on iPad; five stable product tabs                                             | SwiftUI prototype uses `TabView` and `.sidebarAdaptable`                                        |
| Navigation            | One native stack per tab, system back button, interactive edge pop, state restoration from authoritative stacks                                                 | Source candidate binds `NavigationStack` paths to one mock authority; runtime proof unavailable |
| Liquid Glass/material | Standard tabs, bars, toolbars, and sidebars adopt system Liquid Glass and accessibility variants; content uses standard material only where semantically useful | No CSS imitation; requires iOS/iPadOS 26 runtime inspection                                     |
| Scroll edge           | Scrolling content extends under system chrome where appropriate; system controls legibility and tab minimization                                                | Candidate has long system scroll content and tab minimize-on-scroll; runtime proof unavailable  |
| Sheets                | System sheet/popover choice, detents, drag indicator, dismissal, and focus restoration                                                                          | Candidate uses medium/large detents; runtime proof unavailable                                  |
| Safe area/keyboard    | System containers own bars, home indicator, keyboard avoidance, rotation, Stage Manager, and multitasking                                                       | Phone/iPad portrait/landscape and floating/docked keyboard are required gates                   |
| Dynamic Type          | Semantic system fonts reflow through accessibility sizes without clipped tab labels, toolbar actions, or sheet rows                                             | Candidate uses semantic fonts and `ViewThatFits`; Accessibility Inspector required              |
| VoiceOver             | System tab/navigation traits, stable order, selected tab announcement, heading focus after route/sheet                                                          | Candidate uses accessibility focus token; real VoiceOver required                               |
| Reduce Motion         | System transitions adapt; custom content replaces spatial movement with a fade or no motion                                                                     | Candidate reads `accessibilityReduceMotion`; real setting required                              |
| Reduce Transparency   | System Liquid Glass adapts; custom material becomes opaque where needed                                                                                         | Candidate reads `accessibilityReduceTransparency`; real setting required                        |
| Pointer/keyboard      | iPad pointer hover, Full Keyboard Access, and non-conflicting shortcuts                                                                                         | Candidate uses hover effects and scoped shortcuts; real hardware/simulator required             |
| Compact/regular       | Compact remains tab-first; regular may expose adaptable sidebar or split view without desktop sidebar reuse                                                     | iPhone and iPad/Stage Manager walkthrough required                                              |

The source-ready Apple candidate is
[`MishShellPrototype.swiftpm`](../../prototypes/mobile-shell/ios/MishShellPrototype.swiftpm/Package.swift).
It uses only system SwiftUI components. It is not linked into Tauri and was not
compiled because the host has no Xcode or iOS SDK.

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

SwiftUI is the preferred behavior description for a new standalone Apple app:
it provides concise system tabs, navigation stacks, sheets, Dynamic Type,
accessibility environments, and adaptive sidebar behavior. The prototype uses
it for those reasons.

For Mish's current Tauri boundary, UIKit is the lower-risk host integration
candidate because Tauri exposes an existing `UIViewController` and `WKWebView`.
The bounded production exploration should test a UIKit
`UITabBarController`/`UINavigationController` container that reparents one
WKWebView projection, or a `UIHostingController` wrapper around the same single
WKWebView. Five independent WebViews are rejected because they multiply memory,
Tauri lifecycle, product subscriptions, focus, cookies/storage, and testing.

No UIKit or SwiftUI production choice is accepted until an iOS host prototype
proves one WebView, one navigation authority, correct controller containment,
interactive-pop cancellation, focus, deep links, and Tauri plugin lifecycle.

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

Tauri remains transport and WebView infrastructure, not navigation authority.

Android:

- Keep `TauriActivity` and the one Tauri WebView.
- Add native chrome through an accepted host adapter or Activity layout, not a
  plugin-owned product store.
- Register one back listener and disable Tauri's fallback WebView-history pop.
- Use the documented WebView inset zeroing pattern after native chrome consumes
  system bars and cutouts; keep IME updates flowing.
- Kotlin invokes the Rust navigation authority through a bounded JNI/FFI seam,
  matching Mish's existing mobile pattern. It publishes only accepted snapshots.

Apple:

- Keep one Tauri `WKWebView` and one mobile Rust process authority.
- Use the WebView/controller hook only inside a bounded host adapter. Do not
  infer that Tauri supports arbitrary root-controller replacement because a
  pointer is exposed.
- UIKit/SwiftUI sends closed navigation intents through FFI and renders complete
  snapshots. Controller delegate callbacks may report gesture progress, cancel,
  or completion but may not invent a committed route.
- The WebView remains a content projection and must not be replicated once per
  tab.

Bridge timing policy:

- Touch-down/ripple/highlight and predictive gesture progress stay local to the
  native presentation for frame-rate responsiveness.
- Selected tab, route title, back availability, and React content update only on
  the accepted snapshot.
- Instrument intent-to-Rust, Rust transition, Rust-to-native render, and
  Rust-to-React projection separately. No threshold is accepted before exact
  device measurements; a visible one-frame mismatch is a candidate failure.

## Reversible migration sequence

These are bounded draft slices, not created Issues.

1. **Common authority contract.** Land the mobile-only Shared Rust navigation
   reducer, native/React snapshot schemas, stale/duplicate/deep-link/back tests,
   and a fixture adapter. Keep the current product shell selected by default.
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
   Liquid Glass, accessibility, pointer/keyboard, deep-link, edge-pop, and
   lifecycle comparisons. Reject the architecture if one-authority synchronization
   or one-WebView containment cannot be proven.
6. **Apple installed-mobile cutover.** Only after hands-on acceptance, enable
   system tabs/navigation for iOS/iPadOS behind a reversible build-time boundary.

Each slice has one observable platform outcome and preserves desktop/browser
behavior. Follow-up Issues may be created only for the accepted slices and must
retain explicit platform dependencies.

## Acceptance decision

The maintainer must accept or reject Android and Apple independently.

| Platform   | Hands-on decision surface                                                                                                                                                                                    | Acceptance signal                                                                                                       | Current state                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Android    | Exact debug APK: native vs current React bars, ripple clipping, selected/pressed/disabled, predictive back cancel/commit/root, insets/IME, TalkBack, light/dark, reduced motion, sheet focus                 | Explicitly accept selective native Material Views plus the one-authority contract, or reject with the observed mismatch | Candidate source delivered; build/runtime evidence recorded in the prototype validation document |
| iOS/iPadOS | Exact Xcode candidate on iPhone and iPad: system tabs/navigation, Liquid Glass, scroll edge, sheet, Dynamic Type, VoiceOver, accessibility settings, pointer/keyboard, compact/regular, deep-link/back/focus | Explicitly accept UIKit/SwiftUI host direction plus the one-authority contract, or reject with the observed mismatch    | Blocked on unavailable Xcode/iOS host; no runtime claim                                          |

The research pull request must remain unmerged and Issue #343 must remain open
until both required platform decisions are explicit or the maintainer explicitly
narrows acceptance to one platform and records the other as deferred.

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
