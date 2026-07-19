import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import type { ProfileClient, ProfilePreviewDto, ProfileSnapshotDto } from "@mish/contracts";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { ProfileProvider } from "../data/profile-provider";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

const preview = {
  classificationCounts: { disabled: 1, overridden: 2, preserved: 3, rejected: 0 },
  groupCount: 4,
  label: "Fictional profile",
  previewId: "preview-fictitious",
  proxyCount: 12,
  ruleCount: 24,
  sensitiveDataNotice: "source-and-configuration-contain-sensitive-data",
  sourceType: "https",
  warningCodes: ["sensitive-data-present"],
} satisfies ProfilePreviewDto;

function desktopSnapshot(): ProfileSnapshotDto {
  return {
    activation: {
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
      refresh: "supported",
      save: "supported",
    },
    profiles: [
      {
        id: "profile-inactive",
        label: "Fictional profile",
        lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
        lastKnownValid: true,
        lastSuccessAt: 1_721_296_000_000,
        source: { display: "https://profiles.example/…", sourceType: "https" },
        status: {
          active: false,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: true,
        },
        warningCodes: ["source-formatting-not-round-tripped"],
      },
      {
        id: "profile-active",
        label: "Active fictional profile",
        lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
        lastKnownValid: true,
        lastSuccessAt: 1_721_296_000_000,
        source: { display: "local-profile.yaml", sourceType: "local-file" },
        status: {
          active: true,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: false,
        },
        warningCodes: [],
      },
    ],
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
    getSnapshot: vi.fn(async () => snapshot),
    preflightHttps: vi.fn(async () => preview),
    preflightLocal: vi.fn(async () => ({ ...preview, sourceType: "local-file" as const })),
    refreshProfile: vi.fn(async () => snapshot),
    savePreview: vi.fn(async () => snapshot),
    stopActiveProfile: vi.fn(async () => snapshot.activation),
    subscribeConnection: vi.fn(() => () => undefined),
    subscribeSnapshots: vi.fn(() => () => undefined),
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
  it("keeps browser fixture operations disabled and does not fake local file success", async () => {
    renderProfiles();

    expect(await screen.findByText("Studio route set")).toBeInTheDocument();
    expect(screen.getByText(/fictional metadata/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose local file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import HTTPS" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
  });

  it("preflights and saves HTTPS input without rendering the raw tokenized URL", async () => {
    const user = userEvent.setup();
    const client = createDesktopClient();
    renderProfiles(client);
    await screen.findByText("Fictional profile");

    await user.click(screen.getByRole("button", { name: "Import HTTPS" }));
    const urlInput = screen.getByLabelText("HTTPS profile URL");
    expect(urlInput).toHaveAttribute("type", "password");
    const rawUrl = "https://profiles.example/config.yaml?token=private-token";
    await user.type(urlInput, rawUrl);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("Ready to save")).toBeInTheDocument();
    expect(client.preflightHttps).toHaveBeenCalledWith(rawUrl, undefined);
    expect(screen.queryByDisplayValue(rawUrl)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private-token");
    expect(document.body.textContent).not.toContain("not-a-real-password");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(client.savePreview).toHaveBeenCalledWith("preview-fictitious"));
    expect(screen.queryByText("Ready to save")).not.toBeInTheDocument();
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
});
