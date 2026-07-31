import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
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
  observation: null,
  observed: "disabled" as const,
  phase: "off" as const,
};

function renderControl(onSystemProxyChange = vi.fn()) {
  return render(
    <MemoryRouter>
      <TypesafeI18n locale="en">
        <TooltipProvider>
          <TrafficCaptureControl
            adapterKind="fixture"
            capabilities={{ systemProxy: "fixture-only", tun: "fixture-only" }}
            commandSupported
            onSystemProxyChange={onSystemProxyChange}
            onTunChange={vi.fn()}
            systemProxyEnabled={false}
            systemProxySelected={false}
            systemProxyStatus={systemProxyStatus}
            tunEnabled={false}
            tunSelected={false}
            tunStatus={tunStatus}
          />
        </TooltipProvider>
      </TypesafeI18n>
    </MemoryRouter>,
  );
}

describe("TrafficCaptureControl Virtual Interface boundary", () => {
  it("keeps Virtual Interface disabled while exposing its explanation on focus", async () => {
    const user = userEvent.setup();
    renderControl();

    const unavailableTrigger = document.querySelector<HTMLElement>(
      "[data-capture-unavailable-trigger]",
    );
    if (!unavailableTrigger) throw new Error("Missing unavailable Virtual Interface trigger");
    const tun = screen.getByRole("button", { name: /Virtual Interface, not selected/ });

    expect(tun).toBeDisabled();
    expect(unavailableTrigger).toHaveAccessibleName("Virtual Interface");
    expect(unavailableTrigger).toHaveAttribute("aria-describedby", "tun-unavailable-description");

    unavailableTrigger.focus();
    await screen.findByText("Virtual Interface is not available in this version of Mish.");
    await user.keyboard("{Enter}");

    expect(tun).toBeDisabled();
  });

  it("opens Helper setup before requesting a permission-required Virtual Interface", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    const tun = screen.getByRole("button", { name: /Virtual Interface, not selected/ });
    expect(tun).toBeEnabled();
    expect(tun).toHaveAttribute("aria-describedby", "tun-permission-description");

    await user.click(tun);
    expect(screen.getByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeVisible();
    expect(screen.getByText("Helper setup required")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review Helper Setup" })).toBeVisible();
    expect(onTunChange).not.toHaveBeenCalled();
  });

  it("starts the GUI Helper installation without entering Capture activation", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    const install = vi.fn(
      async (): Promise<TunHelperOperationResult> => ({
        ok: true,
      }),
    );
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunHelperInstall={install}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Install Helper" }));

    expect(install).toHaveBeenCalledOnce();
    expect(onTunChange).not.toHaveBeenCalled();
  });

  it("uses the authoritative Capture path when the Helper is already healthy", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunHelperReady
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));

    expect(screen.queryByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeNull();
    expect(onTunChange).toHaveBeenCalledWith(true);
  });

  it("leaves System Proxy actionable", async () => {
    const user = userEvent.setup();
    const onSystemProxyChange = vi.fn();
    renderControl(onSystemProxyChange);

    await user.click(screen.getByRole("button", { name: /System Proxy, not selected/ }));

    expect(onSystemProxyChange).toHaveBeenCalledOnce();
    expect(onSystemProxyChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("makes Virtual Interface actionable only for a supported native RPC projection", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "supported" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    expect(onTunChange).toHaveBeenCalledOnce();
    expect(onTunChange.mock.calls[0]?.[0]).toBe(true);
  });
});
