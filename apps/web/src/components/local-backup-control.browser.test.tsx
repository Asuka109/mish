import type {
  LocalBackupClient,
  LocalBackupPreviewDto,
  LocalBackupScopeDto,
  LocalRestoreConflictResolution,
  LocalRestoreResultDto,
  SettingsSnapshotDto,
  StatusConnectionState,
} from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createFixtureSettingsSnapshot,
  FixtureSettingsClient,
} from "../data/fixture-settings-client";
import { SettingsProvider } from "../data/settings-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { LocalBackupControl } from "./local-backup-control";
import "../styles.css";

function preview(scope: LocalBackupScopeDto, previewId: string): LocalBackupPreviewDto {
  return {
    contentBytes: 4_096,
    excludedSensitiveData: ["credentials-and-profile-contents", "subscription-urls-and-full-paths"],
    fileType: "application/json",
    formatVersion: 1,
    included: {
      patches: scope.patches ? 1 : 0,
      profiles: scope.profiles ? 1 : 0,
      schedules: scope.schedules ? 1 : 0,
      settings: scope.settings ? 1 : 0,
    },
    includedSensitiveData: [],
    maxBytes: 8 * 1_024 * 1_024,
    previewId,
    scope,
  };
}

class BrowserSettingsClient extends FixtureSettingsClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener({ attempt: 0, phase: "connected", stale: false });
    return () => this.connectionListeners.delete(listener);
  }

  replaceSession() {
    for (const listener of this.connectionListeners) {
      listener({ attempt: 1, phase: "disconnected", stale: true });
      listener({ attempt: 1, phase: "connected", stale: false });
    }
  }
}

class DeferredLocalBackupClient implements LocalBackupClient {
  readonly availability = "supported" as const;
  readonly previewExport = vi.fn(
    (scope: LocalBackupScopeDto) =>
      new Promise<LocalBackupPreviewDto>((resolve) => {
        this.resolvePreview = () =>
          resolve(preview(scope, `browser-preview-${++this.previewCount}`));
      }),
  );
  readonly saveExport = vi.fn(async (_previewId: string) => ({ status: "written" as const }));
  readonly previewRestore = vi.fn(async () => null);
  readonly commitRestore = vi.fn(
    async (
      _previewId: string,
      _resolution: LocalRestoreConflictResolution,
    ): Promise<LocalRestoreResultDto> => {
      throw new Error("Restore is not part of this Browser Mode scenario");
    },
  );
  private previewCount = 0;
  private resolvePreview: (() => void) | null = null;

  resolveDeferredPreview() {
    const resolve = this.resolvePreview;
    this.resolvePreview = null;
    resolve?.();
  }
}

let root: Root;

beforeAll(() => {
  loadAllLocales();
  document.body.innerHTML = '<div id="local-backup-control-browser-root"></div>';
  const container = document.getElementById("local-backup-control-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
});

afterAll(() => root.unmount());

function renderHost(
  settingsClient = new BrowserSettingsClient(),
  backupClient = new DeferredLocalBackupClient(),
) {
  root.unmount();
  const container = document.getElementById("local-backup-control-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
  const settingsSnapshot: SettingsSnapshotDto = {
    ...createFixtureSettingsSnapshot(),
    capabilities: {
      ...createFixtureSettingsSnapshot().capabilities,
      backupRestore: "supported",
    },
  };
  root.render(
    <TypesafeI18n locale="en">
      <SettingsProvider
        client={settingsClient}
        initialSnapshot={settingsSnapshot}
        localBackupClient={backupClient}
      >
        <TooltipProvider>
          <LocalBackupControl />
        </TooltipProvider>
      </SettingsProvider>
    </TypesafeI18n>,
  );
  return { backupClient, settingsClient };
}

async function openExportDialog() {
  await userEvent.click(page.getByRole("button", { name: "Create Backup" }));
  return page.getByRole("dialog", { name: "Create local backup" });
}

describe("Local Backup export authority in Browser Mode", () => {
  test("keeps Save blocked while preview is deferred, then unlocks only the accepted preview", async () => {
    const { backupClient } = renderHost();
    const dialog = await openExportDialog();
    const save = dialog.getByRole("button", { name: "Choose Location and Save" });

    await expect.element(save).toBeDisabled();
    await userEvent.click(dialog.getByRole("button", { name: "Generate Preview" }));
    await expect.poll(() => backupClient.previewExport.mock.calls.length).toBe(1);
    await expect.element(save).toBeDisabled();

    backupClient.resolveDeferredPreview();
    await expect.element(dialog.getByText("JSON · v1")).toBeVisible();
    await expect.element(save).toBeEnabled();

    await userEvent.click(save);
    await expect.poll(() => backupClient.saveExport.mock.calls.length).toBe(1);
    expect(backupClient.saveExport).toHaveBeenCalledWith("browser-preview-1");
  });

  test("drops a deferred completion when scope changes before it is accepted", async () => {
    const { backupClient } = renderHost();
    const dialog = await openExportDialog();
    await userEvent.click(dialog.getByRole("button", { name: "Generate Preview" }));
    await expect.poll(() => backupClient.previewExport.mock.calls.length).toBe(1);

    await userEvent.click(dialog.getByRole("checkbox", { name: /Application settings/ }));
    backupClient.resolveDeferredPreview();

    await expect
      .element(dialog.getByTestId("local-backup-preview-region"))
      .toHaveTextContent("Credentials, profile configuration contents");
    await expect
      .element(dialog.getByRole("button", { name: "Choose Location and Save" }))
      .toBeDisabled();
    expect(backupClient.saveExport).not.toHaveBeenCalled();
  });

  test("blocks an accepted preview after RPC session replacement", async () => {
    const settingsClient = new BrowserSettingsClient();
    const { backupClient } = renderHost(settingsClient);
    const dialog = await openExportDialog();
    await userEvent.click(dialog.getByRole("button", { name: "Generate Preview" }));
    await expect.poll(() => backupClient.previewExport.mock.calls.length).toBe(1);
    backupClient.resolveDeferredPreview();
    await expect.element(dialog.getByText("JSON · v1")).toBeVisible();

    settingsClient.replaceSession();
    await userEvent.click(dialog.getByRole("button", { name: "Choose Location and Save" }));

    await expect
      .element(
        page.getByText("Local data changed after validation. Choose the backup again to continue."),
      )
      .toBeVisible();
    expect(backupClient.saveExport).not.toHaveBeenCalled();
    await expect
      .element(dialog.getByRole("button", { name: "Choose Location and Save" }))
      .toBeDisabled();
  });

  test("does not let a replaced session preview completion unlock Save", async () => {
    const settingsClient = new BrowserSettingsClient();
    const { backupClient } = renderHost(settingsClient);
    const dialog = await openExportDialog();
    await userEvent.click(dialog.getByRole("button", { name: "Generate Preview" }));
    await expect.poll(() => backupClient.previewExport.mock.calls.length).toBe(1);

    settingsClient.replaceSession();
    backupClient.resolveDeferredPreview();

    await expect
      .element(
        page.getByText("Local data changed after validation. Choose the backup again to continue."),
      )
      .toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Choose Location and Save" }))
      .toBeDisabled();
    expect(backupClient.saveExport).not.toHaveBeenCalled();
  });
});
