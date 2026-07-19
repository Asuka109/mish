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

1. **Toolbar** — current page title and a quiet active-profile menu.
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
- The profile menu is intentionally muted because profile switching is less
  frequent than changing a group or capture state.

## Session

Session presents:

- current download and upload rates;
- cumulative downloaded and uploaded bytes;
- active connection count;
- effective rule count;
- Mihomo core memory in use; and
- uptime.

Downloaded and Uploaded rows contain optional decorative sparklines. The text
values remain the accessible source of truth. The “Open live traffic” action is
placed in the Session heading and opens the detailed Traffic destination.

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

Services monitors a user-managed set of endpoint probes. The default fixture
contains Google, GitHub, Cloudflare, Baidu, Apple, and Microsoft. Normal display
shows a solid service icon, title, and latency; the URL appears only in the
editor. Manage supports add, edit, delete, and Restore defaults.

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
