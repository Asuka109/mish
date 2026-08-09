import { describe, expect, it, vi } from "vitest";
import { DesktopSupportBundleClient, UnavailableSupportBundleClient } from "./support-bundle";

const preview = {
  categories: [
    { category: "application", itemCount: 1 },
    { category: "activation", itemCount: 1 },
    { category: "platform", itemCount: 1 },
    { category: "capabilities", itemCount: 1 },
    { category: "active-profile", itemCount: 0 },
    { category: "capture", itemCount: 1 },
    { category: "service-probes", itemCount: 0 },
    { category: "events-summary", itemCount: 0 },
    { category: "redaction-report", itemCount: 12 },
    { category: "termination-recovery-evidence", itemCount: 0 },
    { category: "updater", itemCount: 1 },
  ],
  contentBytes: 4_096,
  excludedOrRedacted: [
    "raw-profile-configuration",
    "subscription-urls",
    "credentials-and-secrets",
    "full-paths",
    "node-labels",
    "connection-destinations",
    "process-paths",
    "network-addresses-and-hostnames",
    "private-endpoints",
    "controller-payloads",
    "status-bar-labels",
    "event-text",
  ],
  fileType: "application/json",
  formatVersion: 3,
  maxBytes: 256 * 1_024,
  previewId: "preview-1",
  timeRange: null,
};

describe("desktop support bundle client", () => {
  it("validates preview and save responses through private invoke functions", async () => {
    const invokePreview = vi.fn(async () => preview);
    const invokeSave = vi.fn(async () => ({ status: "written" }));
    const client = new DesktopSupportBundleClient({ invokePreview, invokeSave });

    await expect(client.preview()).resolves.toEqual(preview);
    await expect(client.save("preview-1")).resolves.toEqual({ status: "written" });
    expect(invokePreview).toHaveBeenCalledOnce();
    expect(invokeSave).toHaveBeenCalledWith("preview-1");
  });

  it("rejects invalid or oversized native payloads", async () => {
    const client = new DesktopSupportBundleClient({
      invokePreview: async () => ({ ...preview, contentBytes: 256 * 1_024 + 1 }),
      invokeSave: async () => ({ status: "uploaded" }),
    });

    await expect(client.preview()).rejects.toThrow();
    await expect(client.save("preview-1")).rejects.toThrow();
  });

  it("keeps browser export explicitly unavailable without invoking anything", async () => {
    const client = new UnavailableSupportBundleClient();
    expect(client.availability).toBe("unavailable");
    await expect(client.preview()).rejects.toMatchObject({ code: "unsupported" });
    await expect(client.save("preview-1")).rejects.toMatchObject({ code: "unsupported" });
  });
});
