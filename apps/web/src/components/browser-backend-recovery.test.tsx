import type { StatusConnectionState } from "@mish/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
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

function renderRecovery(
  monitor: ConnectionMonitor,
  overrides: Partial<ComponentProps<typeof BrowserBackendRecovery>> = {},
) {
  return render(
    <TypesafeI18n locale="en">
      <BrowserBackendRecovery
        backendPort={6474}
        connection={monitor}
        runtime="browser"
        {...overrides}
      >
        <button>Stale application control</button>
      </BrowserBackendRecovery>
    </TypesafeI18n>,
  );
}

describe("browser backend recovery", () => {
  it("replaces the stale shell only after a browser connection was once healthy", () => {
    const monitor = new ConnectionMonitor({ attempt: 0, phase: "disconnected", stale: true });
    const onRecoveryRequired = vi.fn();
    renderRecovery(monitor, { onRecoveryRequired });

    expect(screen.getByRole("button", { name: "Stale application control" })).toBeVisible();
    act(() => monitor.emit({ attempt: 0, phase: "connected", stale: false }));
    act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));

    expect(
      screen.queryByRole("button", { name: "Stale application control" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mish stopped responding" })).toHaveFocus();
    expect(screen.getByText("6474")).toBeVisible();
    expect(onRecoveryRequired).toHaveBeenCalledOnce();
  });

  it.each(["desktop", "mobile"] as const)(
    "never promotes disconnection recovery in the %s runtime",
    (runtime) => {
      const monitor = new ConnectionMonitor({ attempt: 0, phase: "connected", stale: false });
      renderRecovery(monitor, { runtime });
      act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));

      expect(screen.getByRole("button", { name: "Stale application control" })).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Mish stopped responding" }),
      ).not.toBeInTheDocument();
    },
  );

  it("supports no-backend retry and reports success before safe navigation", async () => {
    const user = userEvent.setup();
    const monitor = new ConnectionMonitor({ attempt: 0, phase: "connected", stale: false });
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ phase: "not-found" })
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:6476", phase: "found", port: 6476 });
    const navigate = vi.fn();
    renderRecovery(monitor, { discover, navigate });
    act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No running Mish backend");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Found Mish on port 6476");
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:6476"));
  });

  it("cancels discovery and allows another retry", async () => {
    const user = userEvent.setup();
    const monitor = new ConnectionMonitor({ attempt: 0, phase: "connected", stale: false });
    const discover = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ phase: "not-found" }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ phase: "not-found" }), { once: true });
        }),
    );
    renderRecovery(monitor, { discover });
    act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking this port");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("status")).toHaveTextContent("cancelled");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("announces an unexpected discovery failure and keeps retry available", async () => {
    const user = userEvent.setup();
    const monitor = new ConnectionMonitor({ attempt: 0, phase: "connected", stale: false });
    const discover = vi.fn(async () => {
      throw new Error("unexpected failure");
    });
    renderRecovery(monitor, { discover });
    act(() => monitor.emit({ attempt: 5, phase: "disconnected", stale: true }));

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not complete");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
