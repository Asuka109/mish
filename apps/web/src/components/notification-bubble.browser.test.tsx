import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppearanceProvider } from "../appearance";
import { EventsProvider } from "../data/events-provider";
import { createFixtureEventsClient } from "../data/fixture-events-client";
import {
  FixtureSettingsClient,
  createFixtureSettingsSnapshot,
} from "../data/fixture-settings-client";
import { ProductProvider } from "../data/product-provider";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { SettingsProvider } from "../data/settings-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

const longMessage =
  "System Proxy differs from Mish's requested state because the saved recovery record no longer matches the active network configuration.";
const shortMessage = "Synthetic notification remains independently removable";

function notificationMessage(message: string): HTMLParagraphElement {
  const element = [
    ...document.querySelectorAll<HTMLParagraphElement>(".notification-message"),
  ].find((candidate) => candidate.textContent === message);
  if (!element) throw new Error(`Missing notification message: ${message}`);
  return element;
}

function removeButton(message: string): HTMLButtonElement {
  const label = `Remove notification: ${message}`;
  const element = [...document.querySelectorAll<HTMLButtonElement>(".notification-remove")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing notification remove button: ${message}`);
  return element;
}

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  loadAllLocales();
  container = document.createElement("div");
  container.id = "notification-browser-root";
  document.body.append(container);

  const eventsClient = createFixtureEventsClient();
  const eventsSnapshot = await eventsClient.getSnapshot();
  eventsSnapshot.events = [
    {
      detail: null,
      id: "notification-browser:1",
      level: "warning",
      message: shortMessage,
      observedAt: Date.parse("2026-07-21T12:00:00Z"),
      sequence: 1,
      source: "application",
    },
    {
      detail: null,
      id: "notification-browser:2",
      level: "error",
      message: longMessage,
      observedAt: Date.parse("2026-07-21T12:00:01Z"),
      sequence: 2,
      source: "platform",
    },
  ];
  eventsSnapshot.sequence = 2;
  eventsClient.publishSnapshot(eventsSnapshot);

  const settingsSnapshot = createFixtureSettingsSnapshot();
  const settingsClient = new FixtureSettingsClient();
  root = createRoot(container);
  root.render(
    <SettingsProvider client={settingsClient} initialSnapshot={settingsSnapshot}>
      <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
        <TypesafeI18n locale="en">
          <MemoryRouter initialEntries={["/status"]}>
            <ProductProvider>
              <EventsProvider client={eventsClient}>
                <NotificationDeliveryProvider>
                  <TooltipProvider>
                    <NotificationBubble />
                  </TooltipProvider>
                </NotificationDeliveryProvider>
              </EventsProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>
    </SettingsProvider>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector(".notification-trigger")).not.toBeNull();
  });
});

afterAll(() => {
  root.unmount();
  container.remove();
});

describe("notification bubble browser interactions", () => {
  test("wraps and copies messages while revealing independently removable controls", async () => {
    const unreadTrigger = page.getByRole("button", {
      exact: true,
      name: "Notifications, 2 unread",
    });
    await unreadTrigger.click();
    await expect
      .element(page.getByRole("button", { exact: true, name: "Notifications, 0 unread" }))
      .toBeVisible();

    const longMessageLocator = page.getByText(longMessage, { exact: true });
    const shortMessageLocator = page.getByText(shortMessage, { exact: true });
    await expect.element(longMessageLocator).toBeVisible();
    await expect.element(shortMessageLocator).toBeVisible();

    const longMessageElement = notificationMessage(longMessage);
    const longMessageStyle = getComputedStyle(longMessageElement);
    expect(longMessageElement.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(longMessageStyle.lineHeight) * 1.5,
    );
    expect(longMessageStyle.userSelect).toBe("text");
    expect(document.querySelector(".notification-item > span")).toBeNull();

    const shortMessageElement = notificationMessage(shortMessage);
    const shortItem = shortMessageElement.closest(".notification-item");
    if (!shortItem) throw new Error("Missing short notification item");
    const shortRemove = removeButton(shortMessage);
    expect(getComputedStyle(shortRemove).opacity).toBe("0");
    await userEvent.hover(shortItem);
    await vi.waitFor(() => expect(getComputedStyle(shortRemove).opacity).toBe("1"));
    await userEvent.unhover(shortItem);
    await vi.waitFor(() => expect(getComputedStyle(shortRemove).opacity).toBe("0"));

    await userEvent.tab();
    expect(document.activeElement).toBe(shortRemove);
    await vi.waitFor(() => expect(getComputedStyle(shortRemove).opacity).toBe("1"));

    await userEvent.tripleClick(longMessageLocator);
    expect(document.getSelection()?.toString().trim()).toBe(longMessage);
    let copiedText: string | null = null;
    document.addEventListener(
      "copy",
      () => {
        copiedText = document.getSelection()?.toString().trim() ?? null;
      },
      { once: true },
    );
    await userEvent.copy();
    expect(copiedText).toBe(longMessage);

    await page
      .getByRole("button", { exact: true, name: `Remove notification: ${shortMessage}` })
      .click();
    await expect.element(shortMessageLocator).not.toBeInTheDocument();
    await expect.element(longMessageLocator).toBeVisible();
  });
});
