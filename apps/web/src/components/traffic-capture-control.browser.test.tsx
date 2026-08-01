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
function renderHost(
  host: "Settings" | "Status",
  tun: "permission-required" | "repair-required" | "unavailable" = "unavailable",
  onTunHelperSetup?: (
    operation: "install" | "repair",
  ) => Promise<{ ok: true } | { ok: false; failure: null }>,
) {
  const onTunChange = vi.fn();
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter>
        <TooltipProvider>
          <section aria-label={host} className={host === "Settings" ? "max-w-60" : "max-w-120"}>
            <span className="sr-only" id="tun-unavailable-description">
              {unavailableMessage}
            </span>
            <span className="sr-only" id="tun-permission-description">
              Install, approve, or repair the Internal TUN service in Settings before using Virtual
              Interface.
            </span>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunHelperSetup={onTunHelperSetup}
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

describe("Virtual Interface native setup boundary", () => {
  test("keeps an unsupported Virtual Interface unavailable in Status", async () => {
    const onTunChange = renderHost("Status");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await expect.element(tun).toBeDisabled();
    expect(onTunChange).not.toHaveBeenCalled();
  });

  test("keeps an unavailable reason accessible from the narrow Settings host", async () => {
    renderHost("Settings");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await expect.element(tun).toHaveAccessibleDescription(unavailableMessage);
    await expect.element(tun).toBeDisabled();
  });

  test("restores keyboard focus after cancelling the bounded setup explanation", async () => {
    const onTunChange = renderHost("Status", "permission-required");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Tab}");
    await expect.element(tun).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("dialog", { name: "Before enabling Virtual Interface" }))
      .toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(tun).toHaveFocus();
    expect(onTunChange).not.toHaveBeenCalled();
  });

  test("uses the repair lifecycle before automatically resuming the original TUN intent", async () => {
    const setup = vi.fn(async () => ({ ok: true }) as const);
    const onTunChange = renderHost("Status", "repair-required", setup);
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await userEvent.click(tun);
    await expect.element(page.getByText("Helper repair required")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Repair Helper" }));

    await expect.poll(() => setup.mock.calls.length).toBe(1);
    expect(setup).toHaveBeenCalledWith("repair");
    await expect.poll(() => onTunChange.mock.calls.length).toBe(1);
    expect(onTunChange).toHaveBeenCalledWith(true);
  });
});
