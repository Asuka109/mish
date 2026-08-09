import type {
  ApplicationSnapshotDelivery,
  ProfileRouteCatalogDto,
  ProfileSnapshotDto,
  StatusSnapshotDto,
} from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FixtureProfileClient } from "./fixture-profile-client";
import { FixtureStatusClient } from "./fixture-status-client";
import { NotificationDeliveryProvider } from "./notification-delivery";
import { ProductProvider } from "./product-provider";
import { ProfileProvider, useProfiles } from "./profile-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { RoutesPage } from "../pages/routes-page";
import { StatusPage } from "../pages/status-page";
import "../styles.css";

const initialFingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const refreshedFingerprint = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

class EmptyStatusClient extends FixtureStatusClient {
  override getConnectionState() {
    return { attempt: 0, phase: "connected" as const, stale: false };
  }

  override async getSnapshot(): Promise<StatusSnapshotDto> {
    const snapshot = await super.getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.groups = [];
    snapshot.nodes = [];
    snapshot.runtime.phase = "inactive";
    return snapshot;
  }
}

class FirstProfileBrowserClient extends FixtureProfileClient {
  private readonly listeners = new Set<
    (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private readonly profileTemplate: ProfileSnapshotDto["profiles"][number];
  private snapshotState: ProfileSnapshotDto;

  private constructor(
    snapshot: ProfileSnapshotDto,
    template: ProfileSnapshotDto["profiles"][number],
  ) {
    super();
    this.snapshotState = snapshot;
    this.profileTemplate = template;
  }

  static async create() {
    const fixture = new FixtureProfileClient();
    const snapshot = await fixture.getSnapshot();
    const template = structuredClone(snapshot.profiles[0]);
    snapshot.adapterKind = "rpc";
    snapshot.applicationOrder.order = 1;
    snapshot.profiles = [];
    snapshot.selection = { profileId: null, revision: 0 };
    return new FirstProfileBrowserClient(snapshot, template);
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override async savePreview() {
    this.snapshotState = {
      ...this.snapshotState,
      applicationOrder: { ...this.snapshotState.applicationOrder, order: 2 },
      profiles: [structuredClone(this.profileTemplate)],
      selection: { profileId: this.profileTemplate.id, revision: 1 },
    };
    return this.publish();
  }

  override async refreshProfile() {
    const selected = this.snapshotState.profiles[0];
    selected.effectiveFingerprint = refreshedFingerprint;
    selected.runtimeProvenance.artifactFingerprint = refreshedFingerprint;
    this.snapshotState.applicationOrder.order = 3;
    return this.publish();
  }

  override async getRoutes(profileId: string): Promise<ProfileRouteCatalogDto> {
    const profile = this.snapshotState.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error("Unknown Profile route request");
    const refreshed = profile.effectiveFingerprint === refreshedFingerprint;
    const label = refreshed ? "Refreshed configured group" : "First configured group";
    return {
      fingerprint: profile.effectiveFingerprint,
      groups: [
        {
          childIds: ["configured-node"],
          id: "configured-group",
          label,
          selectedChildId: "configured-node",
          type: "selector",
        },
      ],
      nodes: [
        {
          id: "configured-node",
          label: "Configured node",
          latencyMilliseconds: null,
          protocol: "ss",
        },
      ],
      profileId,
      routingMode: "rule",
    };
  }

  override subscribeSnapshots(
    listener: (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish() {
    const snapshot = structuredClone(this.snapshotState);
    for (const listener of this.listeners) listener(snapshot, "update");
    return snapshot;
  }
}

function ProfileMutationControls() {
  const profiles = useProfiles();
  return (
    <div>
      <button onClick={() => void profiles.savePreview("first-preview")} type="button">
        Save first Profile
      </button>
      <button
        disabled={!profiles.selectedProfileAuthority}
        onClick={() => {
          const profileId = profiles.selectedProfileAuthority?.profileId;
          if (profileId) void profiles.refreshProfile(profileId);
        }}
        type="button"
      >
        Refresh same Profile
      </button>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => loadAllLocales());

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

describe("Profile-derived routes in Chromium", () => {
  test("converges Home and Routes after first auto-selection and same-ID refresh", async () => {
    expect(initialFingerprint).not.toBe(refreshedFingerprint);
    const profileClient = await FirstProfileBrowserClient.create();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    root.render(
      <TypesafeI18n locale="en">
        <MemoryRouter>
          <ProductProvider client={new EmptyStatusClient()}>
            <ProfileProvider client={profileClient}>
              <NotificationDeliveryProvider>
                <TooltipProvider>
                  <ProfileMutationControls />
                  <StatusPage />
                  <RoutesPage />
                </TooltipProvider>
              </NotificationDeliveryProvider>
            </ProfileProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>,
    );

    await vi.waitFor(() => expect(page.getByText("No policy groups available.")).toBeVisible());
    await userEvent.click(page.getByRole("button", { name: "Save first Profile" }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('[aria-label="Frequently used policy groups"]'),
      ).toHaveTextContent("First configured group");
      expect(document.querySelector('[aria-label="Routes"]')).toHaveTextContent(
        "First configured group",
      );
    });

    await userEvent.click(page.getByRole("button", { name: "Refresh same Profile" }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('[aria-label="Frequently used policy groups"]'),
      ).toHaveTextContent("Refreshed configured group");
      expect(document.querySelector('[aria-label="Routes"]')).toHaveTextContent(
        "Refreshed configured group",
      );
    });
    expect(
      document.querySelector('[aria-label="Frequently used policy groups"]'),
    ).not.toHaveTextContent("First configured group");
    expect(document.querySelector('[aria-label="Routes"]')).not.toHaveTextContent(
      "First configured group",
    );
  });
});
