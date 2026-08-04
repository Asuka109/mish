# Mobile Navigation and Layout

## Decision

Mish mobile applications use a dedicated bottom-navigation shell rather than a
collapsed or restyled desktop sidebar. Android and iOS share product domains,
routes, accessibility semantics, and brand tokens, but each platform renders
navigation, bars, sheets, motion, typography, and feedback in a style familiar
to that operating system.

The compact mobile hierarchy has five stable top-level destinations:

1. Home
2. Routes
3. Profiles
4. Activity
5. Settings

The six desktop destinations remain unchanged. Mobile groups Traffic and Events
under Activity and keeps Diagnostics beside them as secondary investigation
destinations. This is a navigation adaptation, not a new domain model.

## Navigation map

| Desktop destination | Mobile location                   | Ownership retained                                                          |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| Status              | Home tab                          | Start/stop, VPN state, mode, current Profile, live summary, frequent groups |
| Routes              | Routes tab                        | Policy-group hierarchy, search, testing, and group-owned selection          |
| Profiles            | Profiles tab                      | Import, validation, refresh, activation, patches, and deletion              |
| Traffic             | Activity > Connections and Rules  | Current and closed connections, route detail, ordered rules, provider state |
| Events              | Activity > Events and Diagnostics | Runtime, Core, application, and platform events; guided checks and evidence |
| Settings            | Settings tab                      | Application, VPN, network, DNS, privacy, update, and recovery preferences   |

Every desktop URL remains a valid deep link. Opening `/traffic` or `/events` on
mobile selects Activity and then the matching secondary destination. Back
navigation returns within the current tab before leaving its top-level root.

## Shell ownership

`DesktopShell` and `MobileShell` are separate compositions over the same route
and product providers. Mobile code must not render the `Sidebar` and then move
it to the bottom with CSS. The mobile bottom bar owns only top-level navigation;
VPN start/stop remains a Home command and never consumes a navigation item.

React Router is the sole authority for product routes, child routes, internal
history and Back, per-page state, sheets, scroll state, `canGoBack`, and DOM
focus. Installed-mobile native tab/drawer chrome is a disjoint outer shell: its
selected top-level destination and one-way validated entry are owned by the
Shared Rust contract. Native chrome cannot carry an arbitrary path, and Web
content cannot request a native selection, haptic, sheet, permission, Back, or
focus effect. The current React `MobileShell` remains selected until a separate
platform cutover. Exact ownership is in
[`../architecture/mobile-native-shell-entry.md`](../architecture/mobile-native-shell-entry.md).

## Android presentation

The Android shell follows Material 3 compact-window navigation behavior:

- a bottom Navigation Bar with one icon and short visible label per destination;
- a top app bar for the current title, back navigation, and scoped actions;
- Material pressed, selected, ripple, elevation, and shape behavior;
- edge-to-edge content with system inset handling;
- predictive-back-compatible navigation with no custom conflicting gesture;
- modal or standard bottom sheets for compact filters and contextual choices;
  and
- a floating action button only when one clear creation action dominates the
  current destination, never as a persistent VPN toggle.

Mish colors and status semantics remain recognizable, but the Android shell uses
Android density, typography, motion, and control anatomy. It must not imitate
the iOS floating glass tab bar.

## iOS presentation

The iOS shell follows the current tab-bar and navigation-stack conventions:

- a persistent bottom Tab Bar with system-consistent item spacing and labels;
- one system outer-shell container around one WebView; React Router retains the
  product route stack and internal edge-swipe/Back result;
- system font metrics, Dynamic Type, safe areas, and short labels;
- sheets with appropriate detents for filters and bounded selection;
- immediate touch-down feedback and restrained haptics for meaningful commits;
- translucent floating chrome where legibility permits, with deterministic
  opaque fallbacks for Reduce Transparency and increased contrast; and
- interruptible, spatially consistent transitions that reduce to cross-fades
  when Reduce Motion is enabled.

The iOS shell must not copy Android navigation indicators, ripples, floating
action buttons, or sheet anatomy. Product content may share React components,
but platform chrome uses explicit iOS recipes.

## Shared visual boundary

Shared design tokens continue to own brand colors, semantic statuses, spacing
rhythm, data typography, and minimum interaction targets. Platform recipes own:

- bottom-bar geometry and selection treatment;
- top-bar structure;
- sheet and menu presentation;
- motion and haptic feedback;
- platform font resolution; and
- system inset and keyboard behavior.

Implement Android and iOS shell components separately instead of accumulating
platform branches inside one universal navigation component. Reuse shared hooks,
route metadata, accessible names, and commands underneath them.

## Home adaptation

Home is a single-column daily control surface:

- VPN state and the primary start or stop action appear first;
- current Profile and routing mode remain visible without scrolling on common
  phone sizes;
- compact throughput, memory, and health summaries follow;
- frequent policy groups can be changed without opening a complete Routes tree;
  and
- failures replace optimistic state with a direct recovery action.

Desktop sidebar status controls do not appear beside the bottom bar. No command
may depend on hover text to explain its effect.

## Routes adaptation

Routes uses progressive drill-down rather than displaying the complete nested
desktop tree at once:

1. show searchable policy groups with current child and health summary;
2. open one group to show direct children, sorting, and delay-test actions;
3. open child detail only when the user requests protocol or route information;
   and
4. preserve `group -> child` ownership through every selection and shortcut.

Filters and sort controls use a sheet or bounded toolbar action when they do not
fit beside search. Large node sets remain virtualized or collapsed until needed.

## Profiles adaptation

Profiles separates collection, review, and mutation:

- the root shows source, active state, freshness, and primary actions;
- import opens a dedicated source flow;
- preflight and validation use a review screen rather than a desktop-sized
  dialog;
- patch editors and expert source details use child routes with unsaved-change
  protection; and
- active deletion and replacement retain their existing transactional guards.

## Activity adaptation

Activity owns a secondary switcher for Connections, Rules, Events, and
Diagnostics. It is secondary navigation within one top-level tab, not another
bottom bar.

Desktop tables become scan-friendly lists with stable leading identity,
important measures, and disclosure to a detail screen. Connection commands live
on the owning row or detail view. Event filters and diagnostic run history use
bounded sheets or child routes. A transient Activity badge is reserved for a
critical new failure, not ordinary traffic volume.

## Settings adaptation

Settings uses grouped platform-familiar lists. Each substantial subsystem opens
a child screen with a summary, effective state, controls, and recovery guidance.
VPN, DNS, backup, diagnostics, and advanced configuration are not compressed
into one phone-sized form. Unsupported capabilities are omitted when wholly
inapplicable or shown with an explanation when their absence affects a portable
workflow.

## Toolbars, menus, and sheets

- Keep only the title, navigation, one frequent action, and an overflow action
  in a compact top bar.
- Put object-scoped commands beside the object or in its detail screen.
- Use a sheet for a short temporary choice; use a child route for work with
  validation, multiple sections, or unsaved state.
- Replace hover tooltips with visible labels, supporting text, information
  buttons, or detail rows.
- Do not hide a consequential action behind an unlabeled long press.

## Adaptive layout

The first mobile release targets compact phone layouts in portrait and
landscape. Bottom navigation remains the stable handheld model. A later tablet
or foldable navigation rail or split view requires a separate validated
adaptive decision; it must not reintroduce the desktop sidebar merely because
more width is available.

Dense content owns its own scrolling. Pages must not create document-wide
horizontal overflow. Content and interactive controls respect display cutouts,
home indicators, system bars, the software keyboard, and the effective safe
area.

## Accessibility

- Keep visible text labels on all five navigation items.
- Preserve at least a 44px by 44px effective touch target.
- Announce the selected destination and current secondary Activity view.
- Support text scaling without clipping navigation, commands, or status values.
- Pair status color with text or iconography.
- Keep focus restoration deterministic after sheets, dialogs, and child routes.
- Apply reduced motion, increased contrast, and reduced transparency
  independently.

## Anti-patterns

- Six desktop destinations compressed into six equal phone columns.
- A seventh VPN button attached to the bottom navigation.
- Desktop tables made usable only through full-page horizontal scrolling.
- One universal bottom bar styled with small conditional color differences.
- iOS glass effects on Android or Material selection indicators on iOS.
- Navigation or VPN lifetime owned by the WebView.
- Automatic `More` overflow that hides a product destination unpredictably.

## Validation

The evidence matrix for compact viewports, platform recipes, deep links,
navigation state, touch, accessibility, and native VPN behavior lives in
[`../quality/mobile-validation.md`](../quality/mobile-validation.md).
