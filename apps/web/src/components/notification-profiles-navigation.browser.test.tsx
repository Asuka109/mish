import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import { FixtureStatusClient } from "../data/fixture-status-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { RouteFocusManager } from "../platform/route-focus";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

let deliveryClient: FixtureNotificationClient;
let publisher: FixtureNotificationClient;
let root: Root;

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="notification-profiles-navigation-root"></div>';
  const center = new FixtureNotificationCenter();
  deliveryClient = new FixtureNotificationClient(center);
  publisher = new FixtureNotificationClient(center);
  const container = document.getElementById("notification-profiles-navigation-root");
  if (!container) throw new Error("Missing notification navigation browser root");
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter initialEntries={["/status"]}>
        <ProductProvider client={new FixtureStatusClient()}>
          <NotificationDeliveryProvider client={deliveryClient}>
            <TooltipProvider>
              <RouteFocusManager />
              <NotificationBubble />
              <Routes>
                <Route
                  element={
                    <main>
                      <h1>Status</h1>
                    </main>
                  }
                  path="/status"
                />
                <Route
                  element={
                    <main>
                      <h1>Profiles</h1>
                    </main>
                  }
                  path="/profiles"
                />
              </Routes>
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

describe("missing Profile notification navigation", () => {
  test("navigates by keyboard and restores focus without consuming notification history", async () => {
    await publisher.publish(
      notificationPublication("capture.failure", {
        actionIds: ["open-profiles"],
        data: { failure: "configuration-required" },
        dedupeKey: "capture.failure",
        severity: "error",
      }),
    );

    await expect
      .element(
        page.getByText("Choose or import a Profile configuration before launching the proxy."),
      )
      .toBeVisible();
    const action = page.getByRole("button", { exact: true, name: "Open Profiles" });
    await expect.element(action).toBeVisible();
    const actionButton = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] button:not([data-close-button])",
    );
    if (!actionButton) throw new Error("Missing Profiles navigation toast action");
    actionButton.focus();
    expect(document.activeElement).toBe(actionButton);
    await userEvent.keyboard("{Enter}");

    const heading = page.getByRole("heading", { exact: true, name: "Profiles" });
    await expect.element(heading).toBeVisible();
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Profiles");
    });
    expect(
      (await publisher.getSnapshot()).notifications.some(
        ({ dedupeKey }) => dedupeKey === "capture.failure",
      ),
    ).toBe(true);
  });
});
