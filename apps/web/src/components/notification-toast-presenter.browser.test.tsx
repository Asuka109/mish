import { TooltipProvider } from "@mish/ui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { AppearanceProvider } from "../appearance";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { NotificationToaster } from "./notification-toaster";
import { NotificationToastPresenter } from "./notification-toast-presenter";
import "../styles.css";

let center: FixtureNotificationCenter;
let client: FixtureNotificationClient;
let root: Root | null = null;

beforeAll(() => loadAllLocales());

afterEach(() => {
  root?.unmount();
  root = null;
  client?.dispose();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.runtime;
});

function renderMobilePresenter() {
  document.documentElement.dataset.runtime = "mobile";
  center = new FixtureNotificationCenter();
  client = new FixtureNotificationClient(center);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <AppearanceProvider initialPreference="light">
      <TypesafeI18n locale="en">
        <NotificationDeliveryProvider client={client}>
          <TooltipProvider>
            <NotificationToastPresenter suppressActions />
            <NotificationToaster />
          </TooltipProvider>
        </NotificationDeliveryProvider>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

describe("mobile notification toast presentation", () => {
  test("presents and completes a failed route selection without desktop chrome", async () => {
    renderMobilePresenter();
    await client.publish(
      notificationPublication("route.selection-failed", {
        data: { child: "NRT-03" },
        dedupeKey: "route.selection-failed:mobile-test",
        severity: "error",
      }),
    );

    await vi.waitFor(() => expect(document.querySelector("[data-sonner-toast]")).not.toBeNull());
    expect(document.querySelector("[data-sonner-toast]")?.textContent).toContain(
      "Mish could not switch to NRT-03",
    );
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toHaveAttribute("data-x-position", "center");
    expect(toaster).toHaveAttribute("data-y-position", "top");

    const close = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] [data-close-button]",
    );
    if (!close) throw new Error("Missing mobile notification close control");
    await close.click();

    await vi.waitFor(async () => {
      const notification = (await client.getSnapshot()).notifications[0];
      expect(notification?.presentationState).toMatchObject({
        foldReason: "dismissed",
        phase: "folded",
      });
    });
    expect(document.querySelector(".notification-trigger")).toBeNull();
  });

  test("renders only the newest activation error after a retry resolves an unpresented failure", async () => {
    renderMobilePresenter();
    const firstKey = "profile.activation-failure:browser-attempt-1";
    const latestKey = "profile.activation-failure:browser-attempt-2";

    center.publish(
      notificationPublication("profile.activation-failed", {
        data: { failure: "validation" },
        dedupeKey: firstKey,
        severity: "error",
      }),
    );
    center.resolveByDedupeKey(firstKey);
    center.publish(
      notificationPublication("profile.activation-failed", {
        data: { failure: "managed-listener-conflict" },
        dedupeKey: latestKey,
        severity: "error",
      }),
    );

    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1),
    );
    const toast = document.querySelector("[data-sonner-toast]");
    expect(toast?.textContent).toContain(
      "Another process owns a loopback listener required by the managed Core.",
    );
    expect(toast?.textContent).not.toContain("Mihomo rejected the staged profile before launch.");

    const snapshot = await client.getSnapshot();
    expect(snapshot.notifications.find(({ dedupeKey }) => dedupeKey === firstKey)).toMatchObject({
      presentationState: { foldReason: "suppressed", phase: "folded" },
      resolved: true,
      severity: "error",
    });
    expect(snapshot.notifications.find(({ dedupeKey }) => dedupeKey === latestKey)).toMatchObject({
      presentationState: { phase: "presenting" },
      resolved: false,
      severity: "error",
    });
  });
});
