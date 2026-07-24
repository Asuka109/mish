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
let onTunChange = vi.fn<(value: boolean) => void>();

function renderHost(host: "Settings" | "Status") {
  onTunChange = vi.fn<(value: boolean) => void>();
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
              tunGuideIdentity={null}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </section>
        </TooltipProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
}

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="traffic-capture-control-browser-root"></div>';
  const container = document.getElementById("traffic-capture-control-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
});

afterAll(() => root.unmount());

describe("unavailable Virtual Interface tooltip", () => {
  test("opens on pointer hover in Status without activating the disabled control", async () => {
    renderHost("Status");
    const trigger = page.getByLabelText("Virtual Interface", { exact: true });
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await userEvent.hover(trigger);
    await expect.element(page.getByText(unavailableMessage, { exact: true })).toBeVisible();
    await expect.element(tun).toBeDisabled();

    expect(onTunChange).not.toHaveBeenCalled();
  });

  test("opens on keyboard focus in the narrow Settings host", async () => {
    renderHost("Settings");
    const trigger = page.getByLabelText("Virtual Interface", { exact: true });

    await userEvent.tab();
    await userEvent.tab();
    await expect.element(trigger).toHaveFocus();
    await vi.waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>(".tooltip-content");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent(unavailableMessage);
    });
    await expect.element(trigger).toHaveAccessibleDescription(unavailableMessage);
    await userEvent.keyboard("{Enter}");

    expect(onTunChange).not.toHaveBeenCalled();
  });
});
