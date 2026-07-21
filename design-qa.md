# Historical Design QA: macOS title-bar integration

Status: passed and retained only as a change record.

The verified change removed the redundant native title strip, retained the
system-owned traffic-light controls, extended the workspace to the top inset,
and made the sidebar header and non-interactive toolbar regions draggable
without intercepting controls. Browser rendering remained compatible.

Temporary screenshots used during the review were intentionally not committed.
Current visual rules live in [`DESIGN.md`](DESIGN.md); reproducible native-window
checks live in
[`docs/quality/native-sidebar-validation.md`](docs/quality/native-sidebar-validation.md).
