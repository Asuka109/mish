import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import type {
  ProfileClient,
  ProfilePatchEditorDto,
  ProfilePreviewDto,
  ProfileRuntimeProvenanceDto,
  ProfileSnapshotDto,
} from "@mish/contracts";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { ProfileProvider } from "../data/profile-provider";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

const runtimeProvenance = {
  artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  authority: "desktop-policy",
  items: [],
  layers: [
    "source",
    "user-patches",
    "application-policy",
    "platform-integration",
    "effective-runtime",
  ],
  sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  unknownKeyCount: 0,
} satisfies ProfileRuntimeProvenanceDto;

const preview = {
  classificationCounts: {
    applicationOverridden: 1,
    disabled: 0,
    platformOverridden: 0,
    preserved: 3,
    rejected: 0,
  },
  groupCount: 4,
  label: "office-route-set.yaml",
  previewId: "preview-office",
  proxyCount: 12,
  ruleCount: 24,
  runtimeProvenance,
  sensitiveDataNotice: "source-and-configuration-contain-sensitive-data",
  sourceType: "https",
  warningCodes: [],
} satisfies ProfilePreviewDto;

function desktopSnapshot(): ProfileSnapshotDto {
  return {
    activation: {
      activeFingerprint: runtimeProvenance.artifactFingerprint,
      activeProfileId: "profile-home",
      attemptedAt: 1_721_296_000_000,
      availability: "available",
      commandId: null,
      failure: null,
      operation: null,
      phase: "success",
      safeStopped: false,
      startupPolicy: "safe-stopped",
      targetProfileId: null,
    },
    adapterKind: "rpc",
    capabilities: {
      activation: "supported",
      deletion: "supported",
      httpsImport: "supported",
      localFileImport: "permission-required",
      patches: "supported",
      refresh: "supported",
      scheduling: "supported",
      save: "supported",
    },
    profiles: [
      {
        effectiveFingerprint: runtimeProvenance.artifactFingerprint,
        fileName: "studio-route-set.yaml",
        id: "profile-subscription",
        label: "studio-route-set.yaml",
        lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
        lastKnownValid: true,
        lastSuccessAt: 1_721_296_000_000,
        refresh: {
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastSuccessAt: 1_721_296_000_000,
          nextRunAt: 1_721_339_200_000,
          policy: "twelve-hours",
        },
        source: {
          display:
            "https://profiles.example/subscriptions/studio-route-set.yaml?token=visible-token",
          sourceType: "https",
        },
        status: {
          active: false,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: false,
        },
        runtimeProvenance,
        warningCodes: [],
      },
      {
        effectiveFingerprint: runtimeProvenance.artifactFingerprint,
        fileName: "home.yaml",
        id: "profile-home",
        label: "home.yaml",
        lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
        lastKnownValid: true,
        lastSuccessAt: 1_721_296_000_000,
        refresh: {
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          policy: "off",
        },
        source: { display: "home.yaml", sourceType: "local-file" },
        status: {
          active: true,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: false,
        },
        runtimeProvenance,
        warningCodes: [],
      },
    ],
    providers: {
      authority: null,
      capability: "unavailable",
      observationFailure: null,
      observedAt: null,
      providers: [],
      remotelyCancellable: false,
    },
    selection: { profileId: "profile-home", revision: 1 },
  };
}

function createDesktopClient() {
  const snapshot = desktopSnapshot();
  const emptyPatches = {
    activationBlocked: false,
    authority: {
      artifactFingerprint: runtimeProvenance.artifactFingerprint,
      profileId: "profile-subscription",
      sourceRevision: runtimeProvenance.sourceRevision,
    },
    catalog: { groups: [], outbounds: [], ruleProviders: [], rules: [] },
    effectiveFingerprint: runtimeProvenance.artifactFingerprint,
    patches: [],
    schemaVersion: 1,
  } satisfies ProfilePatchEditorDto;
  return {
    activateProfile: vi.fn(async () => snapshot.activation),
    cancelActivation: vi.fn(async () => snapshot.activation),
    createProfile: vi.fn(async () => snapshot),
    deleteProfile: vi.fn(async () => snapshot),
    detachSubscription: vi.fn(async () => snapshot),
    dispose: vi.fn(),
    getConnectionState: vi.fn(() => ({ attempt: 0, phase: "connected" as const, stale: false })),
    getPatches: vi.fn(async () => emptyPatches),
    getSnapshot: vi.fn(async () => snapshot),
    openProfileDirectory: vi.fn(async () => undefined),
    preflightHttps: vi.fn(async () => preview),
    preflightLocal: vi.fn(async () => ({ ...preview, sourceType: "local-file" as const })),
    refreshProfile: vi.fn(async () => snapshot),
    replacePatches: vi.fn(async () => emptyPatches),
    setRefreshPolicy: vi.fn(async () => snapshot),
    savePreview: vi.fn(async () => snapshot),
    selectProfile: vi.fn(async () => snapshot),
    stopActiveProfile: vi.fn(async () => snapshot.activation),
    subscribeConnection: vi.fn(() => () => undefined),
    subscribeSnapshots: vi.fn(() => () => undefined),
    updateAllProviders: vi.fn(async () => ({
      failed: [],
      failure: null,
      operation: "update-all" as const,
      phase: "success" as const,
      snapshot: snapshot.providers,
      succeededProviderIds: [],
    })),
    updateProvider: vi.fn(async () => ({
      failed: [],
      failure: null,
      operation: "update-one" as const,
      phase: "success" as const,
      snapshot: snapshot.providers,
      succeededProviderIds: [],
    })),
  } satisfies ProfileClient;
}

function renderProfiles(client?: ProfileClient) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/profiles"]}>
          <ProductProvider>
            <ProfileProvider client={client}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </ProfileProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

describe("profiles page", () => {
  it("renders one compact card per local YAML and keeps fixture mutations disabled", async () => {
    renderProfiles();

    expect(await screen.findByText("studio-route-set")).toBeVisible();
    expect(screen.getByText("home")).toBeVisible();
    const subscriptionUrl = screen.getByText(
      "https://profiles.example/subscriptions/studio-route-set.yaml",
    );
    expect(subscriptionUrl).toHaveAttribute(
      "title",
      "https://profiles.example/subscriptions/studio-route-set.yaml",
    );
    expect(subscriptionUrl).toHaveClass("profile-subscription-url");
    expect(screen.getByRole("button", { name: "Update Subscription" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Open Folder" })).toHaveLength(3);
    expect(screen.queryByText("Edit rules and groups")).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime-layer provenance")).not.toBeInTheDocument();
  });

  it("updates a subscription and changes its interval from the alarm menu", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("studio-route-set");

    const subscriptionUrl = screen.getByText(/visible-token/);
    expect(subscriptionUrl).toHaveAttribute("title", subscriptionUrl.textContent);
    await user.click(
      screen.getByRole("button", { name: "Set update interval for studio-route-set.yaml" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "Every 6 hours" }));
    expect(client.setRefreshPolicy).toHaveBeenCalledWith("profile-subscription", "six-hours");

    await user.click(screen.getByRole("button", { name: "Update Subscription" }));
    expect(client.refreshProfile).toHaveBeenCalledWith("profile-subscription");

    const cardFolderButton = screen.getAllByRole("button", { name: "Open Folder" })[1];
    expect(cardFolderButton).toHaveTextContent("");
    await user.click(cardFolderButton);
    expect(client.openProfileDirectory).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Detach the Subscription" }));
    expect(client.detachSubscription).toHaveBeenCalledWith("profile-subscription");

    const localCard = screen.getByText("home").closest("article");
    expect(localCard).not.toBeNull();
    expect(within(localCard!).queryByRole("button", { name: "Update Subscription" })).toBeNull();
  });

  it("opens the managed profile directory through the shared client adapter", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("studio-route-set");

    await user.click(screen.getAllByRole("button", { name: "Open Folder" })[0]);
    expect(client.openProfileDirectory).toHaveBeenCalledOnce();
  });

  it("creates a basic local profile from a normalized file name", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("studio-route-set");

    await user.click(screen.getByRole("button", { name: "New Profile" }));
    await user.type(screen.getByLabelText("Local file name"), "travel.YML");
    await user.click(screen.getByRole("button", { name: "New Profile" }));

    await waitFor(() => expect(client.createProfile).toHaveBeenCalledWith("travel.yml"));
    await waitFor(() => expect(screen.queryByText("Create local profile")).not.toBeInTheDocument());
  });

  it("uses a visible URL field and normalizes the optional subscription file name", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("studio-route-set");

    await user.click(screen.getByRole("button", { name: "Add Subscription" }));
    const urlInput = screen.getByLabelText("Subscription URL");
    expect(urlInput).toHaveAttribute("type", "url");
    await user.type(screen.getByLabelText("Local file name"), "office-route-set");
    await user.type(urlInput, "https://profiles.example/office?token=visible");
    await user.click(screen.getByRole("button", { name: "Check and Save" }));

    await waitFor(() =>
      expect(client.preflightHttps).toHaveBeenCalledWith(
        "https://profiles.example/office?token=visible",
        "office-route-set.yaml",
      ),
    );
    expect(await screen.findByText("Ready to save")).toBeVisible();
    expect(screen.getByText("office-route-set")).toBeVisible();
  });
});
