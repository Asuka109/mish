# Status Experience

## Purpose

Status is the everyday workbench for a running Mish client. It should support
four tasks without becoming a generic proxy dashboard:

1. Start or stop traffic capture.
2. Change routing mode or capture paths.
3. Read live traffic and runtime health.
4. Open a frequently used policy group and change that group's selected child.

Status deliberately does not claim that Rule mode has one globally active
node. Different rules can traverse different groups, and the Mihomo core exposes no
canonical primary group.

## Information hierarchy

The page is arranged in this order:

1. **Toolbar** — current page title and a quiet selected-profile menu.
2. **Routing controls** — two stacked rows in one grouped surface: Routing mode
   and Traffic capture.
3. **Session** — live and cumulative traffic plus compact runtime metrics.
4. **Groups** — the five most-used visible policy groups for the active profile.
5. **Services** — configurable endpoint-latency probes.

The aggregate proxy action lives at the bottom of the sidebar because it is both
global status and the most frequent command. It is named `ProxyControlButton`.

## ProxyControlButton

`ProxyControlButton` is the single everyday start/stop control. Its icon and
label align with the sidebar navigation columns.

| State      | Surface                                      | Default content                    | Hover or keyboard focus                                     | Action                            |
| ---------- | -------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| Inactive   | Transparent, quiet gray hairline             | Power icon, “启动代理”             | Explain the remembered combination or System Proxy fallback | Resume the remembered combination |
| Connecting | Warning treatment                            | Progress wording and icon          | Same meaning                                                | No duplicate start                |
| Healthy    | Blue water material with static DOM fallback | Wi-Fi icon, selected display label | Circle-X icon, “关闭代理”; material brightness stays stable | Pause every selected capture path |
| Error      | Error treatment                              | Failure wording and icon           | Preserve error meaning                                      | Open contextual recovery or retry |

The healthy material is decorative. The button must remain usable before WebGL
initializes, when WebGL fails, under reduced motion, and on low-power devices.
The DOM element owns the fallback blue surface and text contrast.

## Routing and capture

- Routing mode is a mutually exclusive choice: Rule, Global, or Direct.
- System Proxy and Virtual Interface are independent weak-checkbox controls;
  the help dialog explains that Virtual Interface uses TUN.
- The adjacent help button explains the two capture paths in a dialog.
- Stopping through the aggregate control preserves the selected System Proxy
  and Virtual Interface combination, and starting resumes that combination.
- When neither capture mode is selected, starting selects and enables System
  Proxy as the compatibility default.
- Selected capture controls use the same pressed treatment as Routing mode.
  A remembered-but-stopped selection remains muted, while a running selection
  uses a restrained green icon.
- The profile control is a compact framed Select so it reads as persistent
  choice rather than an action menu; it stays quieter than primary controls.
- The profile menu names the user's currently selected configuration, including
  while capture and Mihomo Core are stopped. Selection is the configuration the
  next start will use; it is not evidence that Core or either capture path is
  running.
- Changing the profile menu while the proxy is stopped only changes that
  persisted preference and does not start Core. While System Proxy or Virtual
  Interface is running, the same selection safely switches Core to the chosen
  configuration and preserves the active capture combination. The menu is
  disabled while that switch is pending.
- Selecting an unselected capture mode while stopped starts Mihomo Core with
  that selected configuration, waits for its managed listener to become ready,
  and then applies the complete selected capture combination. The UI must not
  send a capture-only request to a safely stopped runtime.
- A Core start failure returns the aggregate control to its inactive, retryable
  state without clearing the selected capture combination. The failure appears
  once with a specific explanation; the notification center does not add a
  second generic command failure for the same capture attempt.
- Capture drift, typed confirmation failures, and their recovery actions appear
  in transient notifications and the notification center without shifting the
  routing controls. System Proxy drift offers both repair and keep-current when
  the runtime advertises those actions.
- Every application notification is committed exactly once into the shared Rust
  notification Module. Rust-native capture, profile activation, Settings, and
  Traffic producers commit directly; TypeScript-only producers use the one RPC
  publication Interface. Events remain diagnostic history. Every Web client
  projects the same Rust snapshot and gives a newly observed record one matching
  toast. Initial and reconnect baselines never replay old toasts. A specific
  capture/runtime failure suppresses any generic command failure for the same
  attempt. The center orders records by Rust-owned revision and observation;
  severity and available actions never influence ordering. Opening the center
  marks retained items read through Rust without removing them. Messages wrap
  naturally and remain selectable, and source labels are omitted. Users can
  dismiss the client-local toast, but retained center history has no delete
  control; Rust lifecycle resolution, replacement, and retention remain
  authoritative across clients.
- On a fresh eligible desktop installation, the notification center also retains
  one versioned welcome invitation. Existing installations receive the same
  invitation once when upgrading from an older settings schema. On the first
  desktop entry, an unprompted invitation produces a persistent information
  toast with an action that opens the welcome tour; that presentation is recorded
  independently from opening, dismissal, and completion. The four-page tour
  introduces Mish and Mihomo, profiles, System Proxy and TUN capture concepts,
  and routing modes with policy groups. Its inset cover illustration contains no
  localized text. Escape, the close control, and “Not now” persist dismissal
  without removing the invitation; only explicit completion removes it. The tour
  is educational: it performs no Core, capture, network, profile, routing, or
  helper operation and returns focus to the notification trigger when it closes.
  The retained notification has no user-delete control, so the invitation can
  resume in a later app session. Installed mobile builds exclude this invitation
  and dialog.

## Session

Session presents:

- current download and upload rates;
- cumulative downloaded and uploaded bytes;
- active connection count;
- effective rule count;
- Mihomo core memory in use; and
- proxy-session uptime, shown only while System Proxy or Virtual Interface is
  running.

Downloaded and Uploaded rows contain optional decorative sparklines. The text
values remain the accessible source of truth. A new session keeps the chart
viewport empty until its third sample, then grows a right-aligned curve with a
maximum 60-sample window. The “Open live traffic” action is placed in the Session
heading and opens the detailed Traffic destination.

## Groups

Groups shows five policy groups ordered by cumulative, deduplicated connection
observations for the active profile. The count influences ranking only and is
not shown to the user.

Each row contains:

- the rank;
- the complete user-supplied group label;
- the group's currently selected child label and measured latency;
- a badge containing the number of available children; and
- a disclosure indicator.

Activating a row opens the reusable `ProxyPickerDialog` scoped to that group.
Changing a child never implies that the same child is globally active. Ranking
derivation and persistence are specified in
[`../architecture/status-data-contracts.md`](../architecture/status-data-contracts.md).

## Services

Service latency monitors a user-managed set of endpoint probes. The default fixture
contains Google, GitHub, Cloudflare, Baidu, Apple, and Microsoft. Normal display
shows a URL-backed service icon, title, and latency; activating a service runs
that probe immediately and updates its latency in place. The probe URL and icon
URL appear only in the editor. Default icons use version-pinned Remix Icon
assets from the npmmirror CDN, with a neutral cloud symbol for Cloudflare, while
each service may supply its own HTTPS image URL. Manage supports add, an Edit
services dialog, automatic retest interval, delete, and Restore defaults.
Automatic retesting offers 5-second, 10-second, 30-second, and 1-minute cycles.
Disabling it retains the latest results and runs one cycle each time the proxy
starts. Keeping edit behind Manage preserves the service row as a single,
unambiguous test action without adding a competing icon button to every row.

Manage remains openable when service mutation is unavailable so the menu can
explain the capability boundary; unsupported commands remain disabled.

A result means “the configured endpoint responded through the explicitly chosen
probe path.” It is not proof of a globally active proxy node. Probe transport and
security are specified in
[`../architecture/status-data-contracts.md`](../architecture/status-data-contracts.md).

## Responsive behavior

- Session and Groups form two columns at comfortable desktop widths, with
  Session on the left and Groups on the right.
- They stack when the workspace becomes narrow.
- Sparklines disappear before their labels or values become crowded.
- Services uses three columns at comfortable widths and one column when
  constrained.
- At the minimum desktop window width, the complete sidebar remains visible and
  cannot collapse based on viewport width. A future collapsed state must require
  an explicit user control. At mobile browser widths, destinations move to a
  bottom navigation bar and keep short visible labels.
- Dense tables may scroll horizontally inside their own boundary; the app shell
  and page scroller must not overflow the viewport.

## Non-goals

Status is not a rule editor, a complete group tree, a connection inspector, or
a long-term traffic analytics dashboard. It must not infer geography from a
label, infer a primary policy group from naming conventions, or repeat the same
connection status in multiple large surfaces.
