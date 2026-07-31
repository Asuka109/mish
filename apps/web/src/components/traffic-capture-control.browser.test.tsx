import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { TrafficCaptureControl } from "./traffic-capture-control";
import "../styles.css";

const unavailableMessage = "Virtual Interface is not available in this version of Mish.";

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

let root: Root;
function renderHost(host: "Settings" | "Status") {
  const onTunChange = vi.fn();
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter>
        <TooltipProvider>
          <section aria-label={host} className={host === "Settings" ? "max-w-60" : "max-w-120"}>
            <span className="sr-only" id="tun-unavailable-description">
              {unavailableMessage}
            </span>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "unavailable" }}
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
          </section>
        </TooltipProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
  return onTunChange;
}

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="traffic-capture-control-browser-root"></div>';
  const container = document.getElementById("traffic-capture-control-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
});

afterAll(() => root.unmount());

describe("unavailable Virtual Interface authoritative retry", () => {
  test("remains actionable in Status and asks the authority to recheck", async () => {
    const onTunChange = renderHost("Status");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await expect.element(tun).toBeEnabled();
    await userEvent.click(tun);
    expect(onTunChange).toHaveBeenCalledOnce();
    expect(onTunChange.mock.calls[0]?.[0]).toBe(true);
  });

  test("keeps its reason accessible from the narrow Settings host", async () => {
    const onTunChange = renderHost("Settings");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    tun.element().focus();
    await expect.element(tun).toHaveFocus();
    await expect.element(tun).toHaveAccessibleDescription(unavailableMessage);
    await userEvent.keyboard("{Enter}");
    expect(onTunChange).toHaveBeenCalledOnce();
  });
});
