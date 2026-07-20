import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityAvailability } from "@mish/contracts";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { TrafficCaptureControl } from "./traffic-capture-control";
import type { TunHelperOperationResult } from "../data/settings-provider";

loadAllLocales();

const systemProxyStatus = {
  desired: false,
  failure: null,
  observed: "disabled" as const,
  phase: "off" as const,
  recoveryActions: [],
};
const tunStatus = {
  desired: false,
  failure: null,
  observed: "disabled" as const,
  phase: "off" as const,
};

function renderControl(
  onTunChange: (selected: boolean) => void,
  adapterKind: "fixture" | "rpc" = "rpc",
  tunAvailability?: CapabilityAvailability,
  onTunHelperInstall?: () => Promise<TunHelperOperationResult>,
) {
  return render(
    <MemoryRouter>
      <TypesafeI18n locale="en">
        <TrafficCaptureControl
          adapterKind={adapterKind}
          capabilities={{
            systemProxy: adapterKind === "fixture" ? "fixture-only" : "supported",
            tun: tunAvailability ?? (adapterKind === "fixture" ? "fixture-only" : "supported"),
          }}
          commandSupported
          onSystemProxyChange={() => undefined}
          onTunHelperInstall={onTunHelperInstall}
          onTunChange={onTunChange}
          systemProxyEnabled={false}
          systemProxySelected={false}
          systemProxyStatus={systemProxyStatus}
          tunEnabled={false}
          tunGuideIdentity={"a".repeat(64)}
          tunSelected={false}
          tunStatus={tunStatus}
        />
      </TypesafeI18n>
    </MemoryRouter>,
  );
}

describe("TrafficCaptureControl TUN guide", () => {
  it("requires a first real TUN activation to pass through the guide", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    localStorage.setItem("mish.tun-helper-guide.v1", "completed");
    renderControl(onTunChange);
    expect(localStorage.getItem("mish.tun-helper-guide.v1")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));

    expect(screen.getByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeVisible();
    expect(onTunChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onTunChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Enable Virtual Interface" }));

    expect(onTunChange).toHaveBeenCalledOnce();
    expect(onTunChange).toHaveBeenCalledWith(true);
    expect(localStorage.getItem("mish.tun-helper-guide.v2")).toBe("a".repeat(64));
  });

  it("does not repeat a completed guide and leaves fixture behavior unchanged", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mish.tun-helper-guide.v2", "a".repeat(64));
    const completedChange = vi.fn();
    const completed = renderControl(completedChange);

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    expect(screen.queryByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeNull();
    expect(completedChange).toHaveBeenCalledWith(true);
    completed.unmount();

    localStorage.clear();
    const fixtureChange = vi.fn();
    renderControl(fixtureChange, "fixture");
    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    expect(screen.queryByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeNull();
    expect(fixtureChange).toHaveBeenCalledWith(true);
  });

  it("opens the guide instead of faking activation when helper setup is required", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    renderControl(onTunChange, "rpc", "permission-required");

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));

    expect(screen.getByText("Helper setup required")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review helper setup" })).toBeVisible();
    expect(onTunChange).not.toHaveBeenCalled();
    expect(localStorage.getItem("mish.tun-helper-guide.v2")).toBeNull();
  });

  it("starts helper installation inside the guide when the desktop lifecycle is available", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    const install = vi.fn(async () => ({ ok: true }) as const);
    renderControl(onTunChange, "rpc", "permission-required", install);

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Install helper" }));

    expect(install).toHaveBeenCalledOnce();
    expect(onTunChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeVisible();
  });

  it("shows the exact helper installation stage that failed", async () => {
    const user = userEvent.setup();
    const install = vi.fn(async () => ({ failure: "preparation-failed", ok: false }) as const);
    renderControl(vi.fn(), "rpc", "permission-required", install);

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Install helper" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Helper preparation failed before macOS authorization",
    );
  });

  it("repeats the guide after the installed helper identity changes", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mish.tun-helper-guide.v2", "b".repeat(64));
    const onTunChange = vi.fn();
    renderControl(onTunChange);

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));

    expect(screen.getByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeVisible();
    expect(onTunChange).not.toHaveBeenCalled();
  });
});
