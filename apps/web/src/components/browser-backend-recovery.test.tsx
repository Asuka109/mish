import type { StatusConnectionState } from "@mish/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { BrowserBackendRecovery } from "./browser-backend-recovery";

loadAllLocales();

class ConnectionMonitor {
  private listeners = new Set<(state: StatusConnectionState) => void>();

  constructor(private state: StatusConnectionState) {}

  emit(state: StatusConnectionState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  getConnectionState() {
    return this.state;
  }

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function connectedMonitor() {
  return new ConnectionMonitor({ attempt: 0, phase: "connected", stale: false });
}

function disconnect(monitor: ConnectionMonitor) {
  act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));
}

function renderRecovery(
  monitor: ConnectionMonitor,
  overrides: Partial<ComponentProps<typeof BrowserBackendRecovery>> = {},
  locale: "en" | "zh" = "en",
) {
  return render(
    <TypesafeI18n locale={locale}>
      <BrowserBackendRecovery
        backendPort={6474}
        connection={monitor}
        probe={async ({ port }) => ({
          origin: `http://127.0.0.1:${port}`,
          phase: "found",
          port,
        })}
        runtime="browser"
        {...overrides}
      >
        <button>Stale application control</button>
      </BrowserBackendRecovery>
    </TypesafeI18n>,
  );
}

describe("browser backend recovery", () => {
  it("replaces the stale shell with the concise editable recovery controls", () => {
    const monitor = new ConnectionMonitor({ attempt: 0, phase: "disconnected", stale: true });
    const onRecoveryRequired = vi.fn();
    renderRecovery(monitor, { onRecoveryRequired });

    expect(screen.getByRole("button", { name: "Stale application control" })).toBeVisible();
    act(() => monitor.emit({ attempt: 0, phase: "connected", stale: false }));
    disconnect(monitor);

    expect(
      screen.queryByRole("button", { name: "Stale application control" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mish stopped responding" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Backend port" })).toHaveValue("6474");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled();
    expect(
      screen.queryByText(/Application controls are hidden until this browser/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Mish checks it first, then scans/)).not.toBeInTheDocument();
    expect(onRecoveryRequired).toHaveBeenCalledOnce();
  });

  it.each(["desktop", "mobile"] as const)(
    "never promotes disconnection recovery in the %s runtime",
    (runtime) => {
      const monitor = connectedMonitor();
      renderRecovery(monitor, { runtime });
      disconnect(monitor);

      expect(screen.getByRole("button", { name: "Stale application control" })).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Mish stopped responding" }),
      ).not.toBeInTheDocument();
    },
  );

  it("Connect uses exactly the normalized manual port and never invokes discovery", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn();
    const navigation = deferred<void>();
    const navigate = vi.fn(() => navigation.promise);
    const probe = vi.fn(async ({ port }: { port: number }) => ({
      origin: `http://127.0.0.1:${port}`,
      phase: "found" as const,
      port,
    }));
    renderRecovery(monitor, { discover, navigate, probe });
    disconnect(monitor);

    const port = screen.getByRole("textbox", { name: "Backend port" });
    await user.clear(port);
    await user.type(port, "ab080");
    expect(port).toHaveValue("080");
    await user.keyboard("{Enter}");

    expect(discover).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ port: 80, signal: expect.any(AbortSignal) }),
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:80");
    expect(port).toHaveValue("080");
    expect(screen.getByRole("button", { name: "Connecting…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
  });

  it("keeps the recovery page editable when the entered port is offline", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn();
    const navigate = vi.fn();
    const probe = vi.fn().mockResolvedValue({ phase: "empty" });
    renderRecovery(monitor, { discover, navigate, probe });
    disconnect(monitor);

    const port = screen.getByRole("textbox", { name: "Backend port" });
    await user.clear(port);
    await user.type(port, "5000");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not connect to Mish on port 5000",
    );
    expect(port).toHaveValue("5000");
    expect(port).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled();
    expect(probe).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Scan starts at 6474, updates the controlled input, then uses the shared connection path", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn().mockResolvedValue({
      origin: "http://127.0.0.1:6476",
      phase: "found",
      port: 6476,
    });
    const navigate = vi.fn(() => {
      expect(screen.getByRole("textbox", { name: "Backend port" })).toHaveValue("6476");
      return new Promise<void>(() => undefined);
    });
    renderRecovery(monitor, { discover, navigate });
    disconnect(monitor);

    const port = screen.getByRole("textbox", { name: "Backend port" });
    await user.clear(port);
    await user.type(port, "5000");
    await user.click(screen.getByRole("button", { name: "Scan" }));

    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ preferredPort: 6474, signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:6476"));
    expect(port).toHaveValue("6476");
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
  });

  it("keeps the discovered port editable after the shared connection path fails", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn().mockResolvedValue({
      origin: "http://127.0.0.1:6478",
      phase: "found",
      port: 6478,
    });
    const navigate = vi
      .fn()
      .mockRejectedValueOnce(new Error("authentication failed"))
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    renderRecovery(monitor, { discover, navigate });
    disconnect(monitor);

    await user.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not connect to Mish on port 6478",
    );
    const port = screen.getByRole("textbox", { name: "Backend port" });
    expect(port).toHaveValue("6478");
    expect(port).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(navigate).toHaveBeenNthCalledWith(2, "http://127.0.0.1:6478");
    expect(discover).toHaveBeenCalledOnce();
  });

  it("validates manual ports inline while leaving Scan available", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn();
    const navigate = vi.fn();
    renderRecovery(monitor, { discover, navigate });
    disconnect(monitor);

    const port = screen.getByRole("textbox", { name: "Backend port" });
    await user.clear(port);
    expect(port).toHaveAttribute("aria-invalid", "true");
    expect(port).toHaveAccessibleDescription("Enter a port from 1 to 65535.");
    await user.type(port, "65536");

    expect(port).toHaveAttribute("aria-invalid", "true");
    expect(port).toHaveAccessibleDescription("Enter a port from 1 to 65535.");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled();
    fireEvent.submit(port.closest("form")!);
    expect(port).toHaveFocus();
    expect(discover).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reports no backend, then supports a fresh Scan attempt", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ emptyPorts: 5, occupiedPorts: 2, phase: "not-found" })
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:6479", phase: "found", port: 6479 });
    const navigate = vi.fn(() => new Promise<void>(() => undefined));
    renderRecovery(monitor, { discover, navigate });
    disconnect(monitor);

    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No running Mish backend was found.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("occupied");
    expect(screen.getByRole("alert")).not.toHaveTextContent("empty ports");
    expect(screen.getByRole("textbox", { name: "Backend port" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Scan" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:6479"));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("shows action-specific pending states and serializes duplicate submissions", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discovery = deferred<{
      emptyPorts: number;
      occupiedPorts: number;
      phase: "not-found";
    }>();
    const discover = vi.fn(() => discovery.promise);
    const navigate = vi.fn();
    renderRecovery(monitor, { discover, navigate });
    disconnect(monitor);

    const port = screen.getByRole("textbox", { name: "Backend port" });
    await user.click(screen.getByRole("button", { name: "Scan" }));
    const scanning = screen.getByRole("button", { name: "Scanning…" });
    expect(scanning).toBeDisabled();
    expect(scanning).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(port).toBeDisabled();

    fireEvent.submit(port.closest("form")!);
    fireEvent.click(scanning);
    expect(discover).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();

    discovery.resolve({ emptyPorts: 5, occupiedPorts: 0, phase: "not-found" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(port).toBeEnabled();
  });

  it("ignores stale discovery completion after unmount", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discovery = deferred<{
      origin: string;
      phase: "found";
      port: number;
    }>();
    const navigate = vi.fn();
    const view = renderRecovery(monitor, { discover: vi.fn(() => discovery.promise), navigate });
    disconnect(monitor);

    await user.click(screen.getByRole("button", { name: "Scan" }));
    view.unmount();
    discovery.resolve({ origin: "http://127.0.0.1:6480", phase: "found", port: 6480 });
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalled();
  });

  it("announces unexpected Scan failure and keeps both actions available", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    const discover = vi.fn(async () => {
      throw new Error("unexpected failure");
    });
    renderRecovery(monitor, { discover });
    disconnect(monitor);

    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not scan for Mish");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled();
  });

  it("uses localized Chinese action labels without restoring removed explanatory copy", () => {
    const monitor = connectedMonitor();
    renderRecovery(monitor, {}, "zh");
    disconnect(monitor);

    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "扫描" })).toBeEnabled();
    expect(screen.queryByText(/应用操作将保持隐藏/)).not.toBeInTheDocument();
    expect(screen.queryByText(/从 6474 开始扫描/)).not.toBeInTheDocument();
  });

  it("places concise Chinese operation errors below the actions", async () => {
    const user = userEvent.setup();
    const monitor = connectedMonitor();
    renderRecovery(
      monitor,
      {
        discover: vi.fn().mockResolvedValue({
          emptyPorts: 5,
          occupiedPorts: 0,
          phase: "not-found",
        }),
      },
      "zh",
    );
    disconnect(monitor);

    await user.click(screen.getByRole("button", { name: "扫描" }));

    const error = await screen.findByRole("alert");
    const actions = screen.getByRole("button", { name: "连接" }).parentElement;
    expect(error).toHaveTextContent("未找到正在运行的 Mish 后端。");
    expect(error).not.toHaveTextContent("检查了");
    expect(actions?.nextElementSibling).toContainElement(error);
  });

  it("keeps the two actions in a compact non-wrapping layout", () => {
    const monitor = connectedMonitor();
    renderRecovery(monitor);
    disconnect(monitor);

    const connect = screen.getByRole("button", { name: "Connect" });
    const scan = screen.getByRole("button", { name: "Scan" });
    expect(connect.parentElement).toHaveClass("grid", "grid-cols-2", "gap-sm");
    expect(connect).toHaveClass("whitespace-nowrap");
    expect(scan).toHaveClass("whitespace-nowrap");
  });
});
