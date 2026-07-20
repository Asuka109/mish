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
  items: [
    {
      activationImpact: "preserved-in-effective-runtime",
      disposition: "preserved",
      fieldIdentity: "rules",
      owner: "source",
      reason: "portable-source-policy",
      sourcePresent: true,
    },
    {
      activationImpact: "replaced-by-application-value",
      disposition: "application-overridden",
      fieldIdentity: "mixed-port",
      owner: "application-policy",
      reason: "managed-proxy-ingress",
      sourcePresent: true,
    },
  ],
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
    disabled: 1,
    platformOverridden: 1,
    preserved: 3,
    rejected: 0,
  },
  groupCount: 4,
  label: "虚构配置 🛰️",
  previewId: "preview-fictitious",
  proxyCount: 12,
  ruleCount: 24,
  runtimeProvenance,
  sensitiveDataNotice: "source-and-configuration-contain-sensitive-data",
  sourceType: "https",
  warningCodes: ["sensitive-data-present"],
} satisfies ProfilePreviewDto;

function desktopSnapshot(): ProfileSnapshotDto {
  return {
    activation: {
      activeFingerprint: runtimeProvenance.artifactFingerprint,
      activeProfileId: "profile-active",
      attemptedAt: 1,
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
        id: "profile-inactive",
        label: "Fictional profile",
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
        source: { display: "https://profiles.example/…", sourceType: "https" },
        status: {
          active: false,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: true,
        },
        runtimeProvenance,
        warningCodes: ["source-formatting-not-round-tripped"],
      },
      {
        effectiveFingerprint: runtimeProvenance.artifactFingerprint,
        id: "profile-active",
        label: "Active fictional profile",
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
        source: { display: "local-profile.yaml", sourceType: "local-file" },
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
      authority: {
        profileId: "profile-active",
        runtimeFingerprint: runtimeProvenance.artifactFingerprint,
      },
      capability: "supported",
      observationFailure: null,
      observedAt: 1_721_296_000_000,
      providers: [
        {
          behavior: null,
          healthyRecordCount: 2,
          health: "available",
          id: "provider:proxy-fixture",
          kind: "proxy",
          label: "Remote proxy set",
          recordCount: 2,
          sourceType: "http",
          updatedAt: "2026-07-19T01:02:03Z",
          update: {
            attemptedAt: null,
            failure: null,
            finishedAt: null,
            phase: "idle",
          },
        },
        {
          behavior: "domain",
          healthyRecordCount: null,
          health: "available",
          id: "provider:rule-fixture",
          kind: "rule",
          label: "Remote rule set",
          recordCount: 7,
          sourceType: "file",
          updatedAt: "2026-07-19T01:02:03Z",
          update: {
            attemptedAt: null,
            failure: null,
            finishedAt: null,
            phase: "idle",
          },
        },
      ],
      remotelyCancellable: false,
    },
  };
}

function createDesktopClient() {
  const snapshot = desktopSnapshot();
  return {
    activateProfile: vi.fn(async (commandId: string, profileId: string) => ({
      ...snapshot.activation,
      commandId,
      operation: "activate" as const,
      phase: "pending" as const,
      targetProfileId: profileId,
    })),
    cancelActivation: vi.fn(async () => snapshot.activation),
    deleteProfile: vi.fn(async () => snapshot),
    dispose: vi.fn(),
    getConnectionState: vi.fn(() => ({ attempt: 0, phase: "connected" as const, stale: false })),
    getPatches: vi.fn(async (authority) => emptyPatchEditor(authority)),
    getSnapshot: vi.fn(async () => snapshot),
    preflightHttps: vi.fn(async () => preview),
    preflightLocal: vi.fn(async () => ({ ...preview, sourceType: "local-file" as const })),
    refreshProfile: vi.fn(async () => snapshot),
    replacePatches: vi.fn(async (authority) => emptyPatchEditor(authority)),
    setRefreshPolicy: vi.fn(async () => snapshot),
    savePreview: vi.fn(async () => snapshot),
    stopActiveProfile: vi.fn(async () => snapshot.activation),
    updateAllProviders: vi.fn<ProfileClient["updateAllProviders"]>(async () => ({
      failed: [],
      failure: null,
      operation: "update-all",
      phase: "success",
      snapshot: snapshot.providers,
      succeededProviderIds: [],
    })),
    updateProvider: vi.fn<ProfileClient["updateProvider"]>(async () => ({
      failed: [],
      failure: null,
      operation: "update-one",
      phase: "success",
      snapshot: snapshot.providers,
      succeededProviderIds: [],
    })),
    subscribeConnection: vi.fn(() => () => undefined),
    subscribeSnapshots: vi.fn(() => () => undefined),
  } satisfies ProfileClient;
}

function emptyPatchEditor(
  authority: Parameters<ProfileClient["getPatches"]>[0],
): ProfilePatchEditorDto {
  return {
    activationBlocked: false,
    authority,
    catalog: { groups: [], outbounds: [], ruleProviders: [], rules: [] },
    effectiveFingerprint: authority.artifactFingerprint,
    patches: [],
    schemaVersion: 1 as const,
  };
}

function populatedPatchEditor(
  authority: Parameters<ProfileClient["getPatches"]>[0],
): ProfilePatchEditorDto {
  const outboundId = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  return {
    ...emptyPatchEditor(authority),
    catalog: {
      groups: [],
      outbounds: [{ id: outboundId, kind: "built-in", label: "DIRECT" }],
      ruleProviders: [],
      rules: [],
    },
    patches: [
      {
        activationImpact: "insert-rule",
        enabled: true,
        id: "11111111-1111-4111-8111-111111111111",
        operation: {
          kind: "rule-insert",
          position: "prefix",
          rule: {
            kind: "standard",
            noResolve: false,
            ruleType: "domain-suffix",
            targetId: outboundId,
            value: "fictional.example",
          },
        },
        order: 0,
        status: "enabled",
        target: "Rules · prefix",
        validationCode: "valid",
        validationResult: "valid",
      },
    ],
  };
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
  it("keeps browser fixture operations disabled and does not fake local file success", async () => {
    renderProfiles();

    expect(await screen.findByText("Studio route set")).toBeInTheDocument();
    expect(screen.getByText(/fictional metadata/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose local file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import subscription link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
    expect(
      screen.getByText(/does not observe a real Mihomo runtime or execute provider updates/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Update all proxy providers" })).toBeDisabled();
  });

  it("opens profile warning details from the warning badge", async () => {
    const user = userEvent.setup();
    renderProfiles();
    await screen.findByText("Studio route set");

    await user.click(screen.getByRole("button", { name: "Review warnings for Studio route set" }));

    const dialog = screen.getByRole("dialog", { name: "Warnings for Studio route set" });
    expect(dialog).toHaveTextContent("Comments and source formatting will not be preserved");
  });

  it("opens the fictional provenance detail from the keyboard without claiming desktop validation", async () => {
    const user = userEvent.setup();
    renderProfiles();
    await screen.findByText("Studio route set");

    const summary = screen.getByText("Runtime-layer provenance").closest("summary");
    expect(summary).not.toBeNull();
    summary?.focus();
    expect(summary).toHaveFocus();
    await user.click(summary!);

    expect(screen.getByText("Illustrative browser fixture — not desktop validation")).toBeVisible();
    expect(screen.getByText("mixed-port")).toBeVisible();
    expect(document.body.textContent).not.toContain("source-secret");
  });

  it("keeps provenance review operable in a narrow window", async () => {
    const user = userEvent.setup();
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 560 });
    window.dispatchEvent(new Event("resize"));
    renderProfiles();
    await screen.findByText("Studio route set");

    const summary = screen.getByText("Runtime-layer provenance").closest("summary");
    await user.click(summary!);
    expect(screen.getByText("tun.enable")).toBeVisible();
    expect(screen.getByText(/Forced off before activation/)).toBeVisible();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    window.dispatchEvent(new Event("resize"));
  });

  it("preflights and saves HTTPS input without rendering the raw tokenized URL", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("Fictional profile");

    await user.click(screen.getByRole("button", { name: "Import subscription link" }));
    const urlInput = screen.getByLabelText("Subscription URL");
    expect(urlInput).toHaveAttribute("type", "password");
    const rawUrl = "https://profiles.example/config.yaml?token=private-token";
    await user.type(urlInput, rawUrl);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("Ready to save")).toBeInTheDocument();
    expect(screen.getByText("虚构配置 🛰️")).toBeVisible();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Source → User changes → Application policy → Platform integration → Effective runtime",
      ),
    ).toBeVisible();
    expect(client.preflightHttps).toHaveBeenCalledWith(rawUrl, undefined);
    expect(screen.queryByDisplayValue(rawUrl)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private-token");
    expect(document.body.textContent).not.toContain("not-a-real-password");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(client.savePreview).toHaveBeenCalledWith("preview-fictitious"));
    expect(screen.queryByText("Ready to save")).not.toBeInTheDocument();
  });

  it("keeps fictional patch edits local and protects unsaved changes", async () => {
    const user = userEvent.setup();
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 560 });
    renderProfiles();
    await screen.findByText("Studio route set");

    await user.click(screen.getByRole("button", { name: "Edit rules and groups" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Rules and groups for Studio route set",
    });
    expect(within(dialog).getByText(/Illustrative browser fixture only/)).toBeVisible();
    expect(within(dialog).getByText("Insert rule")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save patches" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    expect(within(dialog).getByText("Unsaved changes")).toBeVisible();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText("Discard unsaved patch changes?")).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "Discard changes" }));
    expect(
      screen.queryByRole("dialog", { name: "Rules and groups for Studio route set" }),
    ).not.toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  });

  it("uses the native local preflight boundary and protects active deletion", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("Fictional profile");

    await user.click(screen.getByRole("button", { name: "Choose local file" }));
    expect(client.preflightLocal).toHaveBeenCalledOnce();
    expect(await screen.findByText("Ready to save")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getAllByRole("button", { name: "Refresh" })[0]);
    expect(client.refreshProfile).toHaveBeenCalledWith("profile-inactive");

    expect(screen.getByRole("button", { name: "Active" })).toBeDisabled();

    const activeDelete = screen.getByRole("button", { name: "Delete Active fictional profile" });
    expect(activeDelete).toBeEnabled();
    await user.click(activeDelete);
    expect(screen.getByText(/choose a validated replacement/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByText(/cannot be deleted without a safe replacement/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Delete Fictional profile" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Delete Fictional profile?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(client.deleteProfile).toHaveBeenCalledWith("profile-inactive");
  });

  it("validates and saves the complete patch draft through revision authority", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    client.getPatches.mockImplementation(async (authority) => populatedPatchEditor(authority));
    client.replacePatches.mockImplementation(async (authority) => emptyPatchEditor(authority));
    renderProfiles(client);
    await screen.findByText("Fictional profile");

    await user.click(screen.getAllByRole("button", { name: "Edit rules and groups" })[0]);
    const dialog = await screen.findByRole("dialog", {
      name: "Rules and groups for Fictional profile",
    });
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    await user.click(within(dialog).getByRole("button", { name: "Save patches" }));

    await waitFor(() => expect(client.replacePatches).toHaveBeenCalledOnce());
    expect(client.replacePatches).toHaveBeenCalledWith(
      {
        artifactFingerprint: runtimeProvenance.artifactFingerprint,
        profileId: "profile-inactive",
        sourceRevision: runtimeProvenance.sourceRevision,
      },
      [
        expect.objectContaining({
          enabled: false,
          id: "11111111-1111-4111-8111-111111111111",
        }),
      ],
    );
  });

  it("shows the fixed automatic refresh boundary only for HTTPS sources", async () => {
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("Fictional profile");

    const schedule = screen.getByRole("combobox", {
      name: "Automatic source refresh Fictional profile",
    });
    expect(schedule).toHaveTextContent("Off");
    expect(screen.getByText(/Only fixed safe intervals are allowed/i)).toBeVisible();
    expect(
      screen.getByRole("combobox", {
        name: "Automatic source refresh Active fictional profile",
      }),
    ).toBeDisabled();
  });

  it("keeps provider partial failures visible instead of reporting success", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    client.updateAllProviders.mockImplementation(async () => {
      const snapshot = desktopSnapshot().providers;
      snapshot.providers[0].update = {
        attemptedAt: 1_721_296_000_000,
        failure: "update-rejected",
        finishedAt: 1_721_296_000_001,
        phase: "failure",
      };
      return {
        failed: [{ failure: "update-rejected" as const, providerId: "provider:proxy-fixture" }],
        failure: null,
        operation: "update-all" as const,
        phase: "partial" as const,
        snapshot,
        succeededProviderIds: ["provider:rule-fixture"],
      };
    });
    renderProfiles(client);
    await screen.findByText("Remote proxy set");

    await user.click(screen.getByRole("button", { name: "Update all proxy providers" }));

    expect(client.updateAllProviders).toHaveBeenCalledWith(
      desktopSnapshot().providers.authority,
      "proxy",
    );
    expect(await screen.findByText(/Provider update was not confirmed/i)).toBeVisible();
  });

  it("shows an actionable capture recovery reason for asynchronous activation failure", async () => {
    const client = createDesktopClient();
    const snapshot = desktopSnapshot();
    snapshot.activation = {
      ...snapshot.activation,
      attemptedAt: 1_721_296_000_000,
      commandId: "11111111-1111-4111-8111-111111111111",
      failure: "capture",
      operation: "activate",
      phase: "failure",
      targetProfileId: "profile-inactive",
    };
    client.getSnapshot.mockResolvedValue(snapshot);

    renderProfiles(client);

    expect(await screen.findByText(/System Proxy recovery blocked activation/i)).toBeVisible();
  });
});
