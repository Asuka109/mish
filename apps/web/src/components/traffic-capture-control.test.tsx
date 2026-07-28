import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { TrafficCaptureControl } from "./traffic-capture-control";

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

  it("points permission-required Virtual Interface setup to Settings", async () => {
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
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

    const unavailableTrigger = document.querySelector<HTMLElement>(
      "[data-capture-unavailable-trigger]",
    );
    if (!unavailableTrigger) throw new Error("Missing unavailable Virtual Interface trigger");

    expect(unavailableTrigger).toHaveAttribute("aria-describedby", "tun-permission-description");
    unavailableTrigger.focus();
    await screen.findByText(
      "Install, approve, or repair the Internal TUN service in Settings before using Virtual Interface.",
    );
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
