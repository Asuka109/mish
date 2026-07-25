import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { Toaster } from "sonner";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{`${location.pathname}${location.search}`}</output>;
}

let deliveryClient: FixtureNotificationClient;
let publisher: FixtureNotificationClient;
let root: Root;

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="notification-diagnostics-action-root"></div>';
  const center = new FixtureNotificationCenter();
  deliveryClient = new FixtureNotificationClient(center);
  publisher = new FixtureNotificationClient(center);
  const container = document.getElementById("notification-diagnostics-action-root");
  if (!container) throw new Error("Missing notification diagnostics browser root");
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter initialEntries={["/status"]}>
        <ProductProvider client={new FixtureStatusClient()}>
          <NotificationDeliveryProvider client={deliveryClient}>
            <TooltipProvider>
              <NotificationBubble />
              <LocationProbe />
              <Toaster closeButton position="bottom-right" />
            </TooltipProvider>
          </NotificationDeliveryProvider>
        </ProductProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
  await vi.waitFor(() => {
    expect(document.querySelector(".notification-trigger")).not.toBeNull();
  });
});

afterAll(() => {
  root.unmount();
  deliveryClient.dispose();
  publisher.dispose();
});

describe("notification diagnostics action", () => {
  test("opens diagnostics from a durable startup-failure toast by keyboard", async () => {
    await publisher.publish(
      notificationPublication("system-proxy.failed", {
        dedupeKey: "system-proxy.failed",
        params: { failure: "core-unhealthy" },
        severity: "error",
      }),
    );

    const action = page.getByRole("button", { exact: true, name: "Open Diagnostics" });
    await expect.element(action).toBeVisible();
    const actionButton = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] button:not([data-close-button])",
    );
    if (!actionButton) throw new Error("Missing diagnostics toast action");
    actionButton.focus();
    expect(document.activeElement).toBe(actionButton);
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByLabelText("Current route"))
      .toHaveTextContent("/events?diagnostics=1&failure=core-unhealthy");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
    expect(
      (await publisher.getSnapshot()).notifications.some(
        ({ dedupeKey }) => dedupeKey === "system-proxy.failed",
      ),
    ).toBe(true);
  });
});
