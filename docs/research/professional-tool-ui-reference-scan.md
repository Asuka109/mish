# Professional Tool UI Reference Scan

Date: 2026-07-15

## Scope

This scan supports the macOS-first Mish client design. It studies restrained
professional tools rather than consumer dashboards, with particular attention
to window structure, hierarchy, borders, shadows, density, navigation, and
progressive disclosure.

The references are official product pages or documentation. The observations
below are design inferences from those sources rather than claims made by the
vendors.

## Reference Board

### JetBrains New UI

- [New UI documentation](https://www.jetbrains.com/help/idea/new-ui.html)
- [Overview screenshot](https://resources.jetbrains.com/help/img/idea/2026.1/new_ui_overview.png)
- [Light theme screenshot](https://resources.jetbrains.com/help/img/idea/2026.1/new_ui_light_theme.png)

JetBrains explicitly frames the redesign around lower visual complexity,
essential actions, and progressive disclosure. The window header gathers the
few actions that describe the current work context, while secondary actions
move into menus. Tool windows remain docked to stable edges, and compact mode
reduces heights, padding, and icon sizes as a coherent density change rather
than a collection of one-off tweaks.

Useful lesson: keep the main canvas quiet, make the current context visible,
and let advanced controls appear when their tool window or menu is opened.

### Xcode

- [Configuring the Xcode project window](https://developer.apple.com/documentation/xcode/configuring-the-xcode-project-window)
- [Annotated project-window screenshot](https://docs-assets.developer.apple.com/published/d950a7772e9d4bfbe652ccb68b3ddc58/xcode-window-areas%402x.png)
- [Editor-area screenshot](https://docs-assets.developer.apple.com/published/c902ea1cf11e2fa48287367f158132d3/configuring-editor-area%402x.png)
- [Apple sidebar guidance](https://developer.apple.com/design/human-interface-guidelines/sidebars)

Xcode is organized as a stable frame: toolbar above, navigator on the leading
edge, editor in the center, inspector on the trailing edge, and debugging below.
The center receives most of the space and visual weight. Side areas can be
shown or hidden as the task changes. The hierarchy is expressed mainly through
placement, material, selection fills, and fine separators; ordinary content is
not wrapped in cards.

Useful lesson: a macOS utility feels native when it behaves like a split-view
workspace, not when every section is given a rounded rectangle.

### Blender

- [Regions](https://docs.blender.org/manual/en/latest/interface/window_system/regions.html)
- [Region anatomy image](https://docs.blender.org/manual/en/latest/_images/interface_window-system_regions_3d-view.png)
- [Tabs and panels](https://docs.blender.org/manual/en/5.0/interface/window_system/tabs_panels.html)
- [Workspaces](https://docs.blender.org/manual/en/latest/interface/window_system/workspaces.html)

Blender is dense but highly systematic. A window is divided into task-specific
areas; each editor is divided into a main region, a thin header, optional tools,
and optional sidebars. Borders are functional resize handles as well as visual
separators. Panels collapse in place, and task-oriented workspace tabs swap the
entire arrangement without changing the visual language.

Useful lesson: density stays understandable when every region has a stable job,
headers share a rhythm, and controls are embedded in their working context.

### Visual Studio Code

- [User interface documentation](https://code.visualstudio.com/docs/editing/userinterface)
- [Interface anatomy screenshot](https://code.visualstudio.com/assets/docs/editing/userinterface/hero.png)

VS Code uses a small set of persistent zones: activity bar, primary and
secondary sidebars, editor, panel, and status bar. Nearly every supporting zone
can be hidden, moved, resized, or restored. The layout survives restarts. Visual
weight stays on the editor while other zones use flat backgrounds and narrow
dividers.

Useful lesson: professional simplicity is partly spatial memory. The user
should know where information will appear before it appears.

### GitHub Desktop

- [GitHub Desktop product page](https://github.com/apps/desktop)
- [Application screenshot](https://images.ctfassets.net/8aevphvgewt8/5fErhOtgvjrf97d7wOoARB/b262e06c615977f33046c468147aa114/screenshot-windows-dark.png?w=2496&fm=webp&q=90)
- [GitHub Desktop overview](https://docs.github.com/en/desktop/overview/about-github-desktop)

GitHub Desktop narrows a complicated domain into one visible workflow. The
repository and branch context sit in the top area, changed files form a stable
list, and the diff owns the main surface. It uses selection fills and separators
more than elevation. Important actions are prominent because there are few of
them, not because they are oversized.

Useful lesson: show the object being acted on, the current mode, and the next
operation in one predictable frame.

### Zed

- [Getting started and panel layouts](https://zed.dev/docs/)
- [Pane and dock glossary](https://zed.dev/docs/development/glossary)
- [Panel system](https://zed.dev/blog/new-panel-system)
- [Appearance controls](https://zed.dev/docs/appearance)

Zed separates the center workspace into panes and places supporting tools in
left, right, or bottom docks. A pane or dock can be temporarily zoomed when it
becomes the primary task. UI, editor, and terminal typography are configurable
as separate systems, but the default workbench remains visually restrained.

Useful lesson: the same surface can support overview and deep work when side
tools are dockable and the active region can temporarily take over the window.

## Shared Design Principles

### The window is the container

The dominant pattern is a small number of large, stable regions. Borders and
background changes describe their boundaries. Cards are exceptions used for a
focused status, modal choice, popover, or temporary elevation.

### Lines explain structure; shadows explain depth

A one-pixel separator answers “where does this region end?” A shadow answers
“what is floating above what?” Using a shadow on every group weakens both
signals. Most ordinary rows should use separators or spacing; a status surface
may use a very light border-plus-shadow treatment if it needs to feel actionable.

### Professional density is organized, not merely compact

The interfaces reuse a small number of row heights, header heights, icon sizes,
and type styles. Density changes happen by switching a whole rhythm, as in
JetBrains compact mode, rather than shrinking isolated controls.

### The main task receives the quietest and largest surface

Navigation and diagnostics stay at the edges. The center is visually calm,
which lets data, code, or the current connection state carry the hierarchy.

### Complexity appears near its cause

Inspectors, tool windows, panels, and menus open next to the object or task they
serve. This keeps the default view simple without hiding capability from expert
users.

### State is shown in several restrained ways

Selection fill, text weight, icon tint, a small status dot, and placement work
together. Saturated color is reserved for active state, health, warnings, or a
primary action.

## Direction for the Mish Sketch

- Keep the current sidebar-plus-workspace frame.
- Treat Overview as a calm inspector-style page, not a dashboard grid.
- Keep one elevated connection surface at most; make remaining groups open
  sections with inset separators.
- Use a small, repeatable row-height system for navigation, property rows, and
  diagnostics.
- Let advanced traffic, DNS, TUN, and log detail open in a docked or secondary
  panel rather than expanding every section in place.
- Use a compact toolbar for current context and frequent actions; move rare
  actions into menus.
- Preserve spatial memory between pages: navigation stays fixed, page title and
  top actions stay in the same positions, and content changes inside the main
  region.
- Avoid decorative cards, strong ambient shadows, gratuitous gradients, large
  marketing typography, and many unrelated corner radii.
