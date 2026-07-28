import { Button, Spinner } from "@mish/ui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { proxyControlStyles } from "./app-shell";
import { TrafficCaptureControl } from "./traffic-capture-control";
import "../styles.css";

const systemProxyStatus = {
  desired: true,
  failure: null,
  observed: "disabled" as const,
  phase: "pending" as const,
  recoveryActions: [],
};

const tunStatus = {
  desired: false,
  failure: null,
  observation: null,
  observed: "disabled" as const,
  phase: "off" as const,
};

function spinnerFor(control: HTMLElement) {
  const spinner = control.querySelector<HTMLElement>(".ui-spinner");
  if (!spinner) throw new Error("Missing pending spinner");
  return spinner;
}

function expectVisibleSpinner(spinner: HTMLElement) {
  const style = getComputedStyle(spinner);

  expect(style.width).toBe("14px");
  expect(style.height).toBe("14px");
  expect(Number.parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
  expect(style.borderTopColor).toBe(style.color);
  expect(style.borderRightColor).toBe("rgba(0, 0, 0, 0)");
}

let root: Root;

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="pending-control-spinner-root"></div>';
  const container = document.getElementById("pending-control-spinner-root");
  if (!container) throw new Error("Missing browser-test root");

  const proxyStyles = proxyControlStyles({ healthy: false });
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter>
        <Button
          aria-busy="true"
          aria-label="Launch Proxy"
          className={proxyStyles.proxyControl()}
          data-status="connecting"
          disabled
          variant="ghost"
        >
          <span
            className={proxyStyles.state({ className: proxyStyles.defaultState() })}
            data-slot="proxy-control-default"
          >
            <Spinner data-icon="inline-start" />
            <span className={proxyStyles.label()}>Pending</span>
          </span>
        </Button>
        <TrafficCaptureControl
          adapterKind="rpc"
          capabilities={{ systemProxy: "supported", tun: "supported" }}
          commandSupported
          disabled
          onSystemProxyChange={vi.fn()}
          onTunChange={vi.fn()}
          pending
          pendingMode="systemProxy"
          systemProxyEnabled={false}
          systemProxySelected
          systemProxyStatus={systemProxyStatus}
          tunEnabled={false}
          tunSelected={false}
          tunStatus={tunStatus}
        />
      </MemoryRouter>
    </TypesafeI18n>,
  );

  await vi.waitFor(() => expect(document.querySelectorAll(".ui-spinner")).toHaveLength(2));
});

afterAll(() => root.unmount());

describe("pending control spinners", () => {
  test("keeps the Launch Proxy spinner visible", () => {
    const control = document.querySelector<HTMLElement>('[aria-label="Launch Proxy"]');
    if (!control) throw new Error("Missing Launch Proxy control");
    expectVisibleSpinner(spinnerFor(control));
  });

  test("keeps the System Proxy spinner visible", () => {
    const control = document.querySelector<HTMLElement>(
      '[aria-label="System Proxy, selected, not running"]',
    );
    if (!control) throw new Error("Missing System Proxy control");
    expectVisibleSpinner(spinnerFor(control));
  });
});
