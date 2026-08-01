import type { ProfileActivationSnapshotDto, ProfileSnapshotDto } from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Toaster } from "sonner";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import { FixtureProfileClient } from "../data/fixture-profile-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import { ProfileProvider } from "../data/profile-provider";
import { FixtureStatusClient } from "../data/fixture-status-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

class RetryProfileClient extends FixtureProfileClient {
  readonly activateProfile = vi.fn(
    async (
      _commandId: string,
      profileId: string,
      _options?: { signal?: AbortSignal },
    ): Promise<ProfileActivationSnapshotDto> => ({
      ...this.snapshotState.activation,
      activeProfileId: profileId,
      failure: null,
      phase: "success",
    }),
  );
  private snapshotState!: ProfileSnapshotDto;

  async initialize() {
    this.snapshotState = await super.getSnapshot();
    this.snapshotState.capabilities.activation = "supported";
    this.snapshotState.activation = {
      ...this.snapshotState.activation,
      availability: "available",
      commandId: "activation-command-1",
      failure: "missing-binary",
      operation: "activate",
      phase: "failure",
      targetProfileId: this.snapshotState.selection.profileId,
    };
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }
}

let deliveryClient: FixtureNotificationClient;
let profileClient: RetryProfileClient;
let publisher: FixtureNotificationClient;
let root: Root;

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="notification-profile-retry-root"></div>';
  const center = new FixtureNotificationCenter();
  deliveryClient = new FixtureNotificationClient(center);
  publisher = new FixtureNotificationClient(center);
  profileClient = new RetryProfileClient();
  await profileClient.initialize();
  const container = document.getElementById("notification-profile-retry-root");
  if (!container) throw new Error("Missing notification retry browser root");
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <MemoryRouter initialEntries={["/status"]}>
        <ProductProvider client={new FixtureStatusClient()}>
          <ProfileProvider client={profileClient}>
            <NotificationDeliveryProvider client={deliveryClient}>
              <TooltipProvider>
                <NotificationBubble />
                <Toaster closeButton position="bottom-right" />
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProfileProvider>
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
  profileClient.dispose();
});

describe("profile activation failure notification action", () => {
  test("retries the failed target by keyboard without folding its toast lifecycle", async () => {
    await publisher.publish(
      notificationPublication("profile.activation-failed", {
        actionIds: ["retry-profile-activation"],
        dedupeKey: "profile.activation-failure:activation-command-1",
        data: { failure: "missing-binary" },
        severity: "error",
      }),
    );

    const action = page.getByRole("button", { exact: true, name: "Retry Activation" });
    await expect.element(action).toBeVisible();
    const actionButton = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] button:not([data-close-button])",
    );
    if (!actionButton) throw new Error("Missing retry toast action");
    actionButton.focus();
    expect(document.activeElement).toBe(actionButton);
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => {
      expect(profileClient.activateProfile).toHaveBeenCalledWith(
        expect.any(String),
        "fixture-profile-studio",
        { signal: expect.any(AbortSignal) },
      );
    });
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    expect(
      (await publisher.getSnapshot()).notifications.some(
        ({ dedupeKey }) => dedupeKey === "profile.activation-failure:activation-command-1",
      ),
    ).toBe(true);
    const closeToast = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] [data-close-button]",
    );
    if (!closeToast) throw new Error("Missing retry toast close control");
    await closeToast.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
    expect(
      (await publisher.getSnapshot()).notifications.find(
        ({ dedupeKey }) => dedupeKey === "profile.activation-failure:activation-command-1",
      )?.presentationState,
    ).toMatchObject({ foldReason: "dismissed", phase: "folded" });
  });
});
