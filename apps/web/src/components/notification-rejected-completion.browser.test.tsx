import type {
  NotificationPresentationClaimDto,
  NotificationPresentationFoldReason,
} from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppearanceProvider } from "../appearance";
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
import { NotificationBubble } from "./notification-bubble";
import { NotificationToaster } from "./notification-toaster";
import "../styles.css";

class DeferredRejectingCompletionClient extends FixtureNotificationClient {
  private rejectCompletionRequest: (() => void) | null = null;

  override async completePresentation(
    _claim: NotificationPresentationClaimDto,
    _outcome: NotificationPresentationFoldReason,
  ) {
    const current = await this.getSnapshot();
    const revision = current.revision + 1;
    const snapshot = {
      notifications: current.notifications.map((record) => ({ ...record, revision })),
      revision,
    };
    return new Promise<{ accepted: boolean; snapshot: typeof snapshot }>((resolve) => {
      this.rejectCompletionRequest = () => {
        this.receive(snapshot);
        resolve({ accepted: false, snapshot });
      };
    });
  }

  rejectPendingCompletion() {
    const reject = this.rejectCompletionRequest;
    if (!reject) throw new Error("No presentation completion is pending");
    this.rejectCompletionRequest = null;
    reject();
  }
}

let client: DeferredRejectingCompletionClient;
let container: HTMLDivElement;
let publisher: FixtureNotificationClient;
let root: Root;

beforeAll(async () => {
  loadAllLocales();
  const center = new FixtureNotificationCenter();
  publisher = new FixtureNotificationClient(center);
  client = new DeferredRejectingCompletionClient(center);
  await publisher.publish(
    notificationPublication("profile.saved", {
      dedupeKey: "rejected-completion",
      severity: "success",
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/status"]}>
          <ProductProvider client={new FixtureStatusClient()}>
            <NotificationDeliveryProvider client={client}>
              <TooltipProvider>
                <NotificationBubble />
                <NotificationToaster />
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
  await vi.waitFor(() => expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1));
});

afterAll(() => {
  root.unmount();
  client.dispose();
  publisher.dispose();
  container.remove();
});

describe("notification presentation rejection", () => {
  test("reprojects a dismissed toast after its active lease rejects the completion", async () => {
    const close = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] [data-close-button]",
    );
    if (!close) throw new Error("Missing notification toast close control");

    await close.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );

    client.rejectPendingCompletion();

    await vi.waitFor(() => {
      const toasts = document.querySelectorAll("[data-sonner-toast]");
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.textContent).toContain("Profile saved");
    });
  });
});
