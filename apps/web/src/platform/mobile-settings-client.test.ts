import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import { describe, expect, it, vi } from "vitest";
import { MobileSettingsClient, type MobileSettingsTransport } from "./mobile-settings-client";

function nativeSnapshot(revision = 1) {
  return { ...createFixtureSettingsSnapshot(), adapterKind: "native" as const, revision };
}

describe("MobileSettingsClient", () => {
  it("accepts only complete native snapshots and forwards portable mutations", async () => {
    const transport = {
      invoke: vi.fn(async (command: string) =>
        command === "mobile_settings_set_appearance" ? nativeSnapshot(2) : nativeSnapshot(),
      ),
    };
    const client = new MobileSettingsClient(transport);
    const updates: number[] = [];
    client.subscribeSnapshots((snapshot) => updates.push(snapshot.revision));

    await expect(client.getSnapshot()).resolves.toMatchObject({
      adapterKind: "native",
      revision: 1,
    });
    await expect(client.setAppearance("dark")).resolves.toMatchObject({ revision: 2 });

    expect(transport.invoke).toHaveBeenNthCalledWith(1, "mobile_settings_get_snapshot", undefined);
    expect(transport.invoke).toHaveBeenNthCalledWith(2, "mobile_settings_set_appearance", {
      request: { appearance: "dark" },
    });
    expect(updates).toEqual([1, 2]);
  });

  it("does not map Android Settings controls to desktop-only commands", async () => {
    const client = new MobileSettingsClient({ invoke: vi.fn(async () => nativeSnapshot()) });

    await expect(
      client.setStartup({
        launchAtLogin: true,
        launchBehavior: "core",
        loginLaunchBehavior: "background",
      }),
    ).rejects.toThrow("Desktop startup settings");
    await expect(client.setWindowSurface("opaque")).rejects.toThrow("Desktop window surface");
  });

  it("does not let a stale native revision replace the latest accepted snapshot", async () => {
    const transport = {
      invoke: vi
        .fn<MobileSettingsTransport["invoke"]>()
        .mockResolvedValueOnce(nativeSnapshot(3))
        .mockResolvedValueOnce(nativeSnapshot(2)),
    };
    const client = new MobileSettingsClient(transport);
    const revisions: number[] = [];
    client.subscribeSnapshots((snapshot) => revisions.push(snapshot.revision));

    await client.getSnapshot();
    await client.getSnapshot();

    expect(revisions).toEqual([3]);
  });

  it("does not accept a native reply after the caller cancels", async () => {
    let resolveNativeReply: ((snapshot: ReturnType<typeof nativeSnapshot>) => void) | undefined;
    const nativeReply = new Promise<ReturnType<typeof nativeSnapshot>>((resolve) => {
      resolveNativeReply = resolve;
    });
    const transport = { invoke: vi.fn(async () => nativeReply) };
    const client = new MobileSettingsClient(transport);
    const revisions: number[] = [];
    client.subscribeSnapshots((snapshot) => revisions.push(snapshot.revision));
    const controller = new AbortController();

    const request = client.getSnapshot({ signal: controller.signal });
    controller.abort();
    resolveNativeReply?.(nativeSnapshot(2));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(revisions).toEqual([]);
  });
});
