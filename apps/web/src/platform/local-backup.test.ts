import { describe, expect, it, vi } from "vitest";
import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import { DesktopLocalBackupClient, UnavailableLocalBackupClient } from "./local-backup";

const scope = {
  patches: true,
  profiles: false,
  schedules: true,
  settings: true,
  sourceLocators: false,
};

const included = { patches: 2, profiles: 0, schedules: 1, settings: 1 };

const exportPreview = {
  contentBytes: 4_096,
  excludedSensitiveData: ["credentials-and-profile-contents", "subscription-urls-and-full-paths"],
  fileType: "application/json",
  formatVersion: 1,
  included,
  includedSensitiveData: [],
  maxBytes: 8 * 1_024 * 1_024,
  previewId: "export-preview-1",
  scope,
};

const restorePreview = {
  actions: { add: 0, replace: 0, skip: 1, update: 2 },
  conflicts: [
    {
      backupFingerprint: "a".repeat(64),
      backupRevision: "b".repeat(64),
      currentFingerprint: "c".repeat(64),
      currentRevision: "d".repeat(64),
      kind: "revision-mismatch",
      label: "Work profile",
      profileId: "cd7cbf96-88a5-41d0-bfd6-fd14fe97420b",
      replaceAllowed: false,
    },
  ],
  contentBytes: 4_096,
  fileType: "application/json",
  formatVersion: 1,
  included,
  maxBytes: 8 * 1_024 * 1_024,
  previewId: "restore-preview-1",
  scope,
};

describe("desktop local backup client", () => {
  it("validates the complete private invoke protocol", async () => {
    const dependencies = {
      invokeCommitRestore: vi.fn(async () => ({
        applied: { add: 0, replace: 0, skip: 1, update: 2 },
        settingsSnapshot: createFixtureSettingsSnapshot(),
      })),
      invokePreviewExport: vi.fn(async () => exportPreview),
      invokePreviewRestore: vi.fn(async () => restorePreview),
      invokeSaveExport: vi.fn(async () => ({ status: "written" })),
    };
    const client = new DesktopLocalBackupClient(dependencies);

    await expect(client.previewExport(scope)).resolves.toEqual(exportPreview);
    await expect(client.saveExport("export-preview-1")).resolves.toEqual({ status: "written" });
    await expect(client.previewRestore()).resolves.toEqual(restorePreview);
    await expect(client.commitRestore("restore-preview-1", "keep-existing")).resolves.toMatchObject(
      {
        applied: { skip: 1, update: 2 },
      },
    );
    expect(dependencies.invokePreviewExport).toHaveBeenCalledWith(scope);
    expect(dependencies.invokeCommitRestore).toHaveBeenCalledWith(
      "restore-preview-1",
      "keep-existing",
    );
  });

  it("rejects malformed or oversized native responses", async () => {
    const client = new DesktopLocalBackupClient({
      invokeCommitRestore: async () => ({ applied: {}, settingsSnapshot: {} }),
      invokePreviewExport: async () => ({ ...exportPreview, contentBytes: 8 * 1_024 * 1_024 + 1 }),
      invokePreviewRestore: async () => ({ ...restorePreview, formatVersion: 2 }),
      invokeSaveExport: async () => ({ status: "uploaded" }),
    });

    await expect(client.previewExport(scope)).rejects.toThrow();
    await expect(client.previewRestore()).rejects.toThrow();
    await expect(client.saveExport("export-preview-1")).rejects.toThrow();
  });

  it("keeps every browser operation explicitly unavailable", async () => {
    const client = new UnavailableLocalBackupClient();
    expect(client.availability).toBe("unavailable");
    await expect(client.previewExport(scope)).rejects.toMatchObject({ code: "unsupported" });
    await expect(client.previewRestore()).rejects.toMatchObject({ code: "unsupported" });
    await expect(client.saveExport("preview-1")).rejects.toMatchObject({ code: "unsupported" });
    await expect(client.commitRestore("preview-1", "keep-existing")).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});
