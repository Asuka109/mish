import { describe, expect, it } from "vitest";
import { SERVICE_ICON_URLS, ServiceIconUrlSchema } from "@mish/contracts";
import { FixtureStatusClient } from "./fixture-status-client";

describe("FixtureStatusClient", () => {
  it("returns detached typed snapshots", async () => {
    const client = new FixtureStatusClient();
    expect(client.supportsCommand("capture")).toBe(true);
    const first = await client.getSnapshot();
    first.profiles[0].label = "Changed outside the adapter";

    const second = await client.getSnapshot();
    expect(second.profiles[0].label).toBe("Home");
    expect(second.adapterKind).toBe("fixture");
    expect(second.runtime.systemProxy.phase).toBe("off");
    expect(second.runtime.captureSelection.systemProxy).toBe(false);
  });

  it("uses the HTTP Microsoft connectivity-test endpoint by default", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();

    expect(snapshot.services.find((service) => service.id === "microsoft")?.url).toBe(
      "http://www.msftconnecttest.com/connecttest.txt",
    );
  });

  it("serializes every default service with a root-relative bundled icon URL", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    const icons = snapshot.services.map((service) => service.icon);

    expect(icons).toEqual([
      SERVICE_ICON_URLS.google,
      SERVICE_ICON_URLS.github,
      SERVICE_ICON_URLS.cloudflare,
      SERVICE_ICON_URLS.baidu,
      SERVICE_ICON_URLS.apple,
      SERVICE_ICON_URLS.microsoft,
    ]);
    expect(icons.every((icon) => icon.startsWith("/assets/remix-icon/"))).toBe(true);
  });

  it("creates, edits, and persists user-selected HTTPS icon URLs", async () => {
    const client = new FixtureStatusClient();
    const created = await client.upsertServiceMonitor({
      icon: "https://example.com/first.svg",
      label: "Custom",
      url: "https://example.com/generate_204",
    });
    const custom = created.services.find((service) => service.label === "Custom");
    expect(custom?.icon).toBe("https://example.com/first.svg");

    const edited = await client.upsertServiceMonitor({
      icon: "https://cdn.example.com/second.webp",
      id: custom?.id,
      label: "Custom",
      url: "https://example.com/generate_204",
    });
    expect(edited.services.find((service) => service.id === custom?.id)?.icon).toBe(
      "https://cdn.example.com/second.webp",
    );
    expect(
      (await client.getSnapshot()).services.find((service) => service.id === custom?.id)?.icon,
    ).toBe("https://cdn.example.com/second.webp");
  });

  it("accepts only recorded local paths or credential-free HTTPS icon URLs", () => {
    expect(ServiceIconUrlSchema.safeParse(SERVICE_ICON_URLS.fallback).success).toBe(true);
    expect(ServiceIconUrlSchema.safeParse("https://example.com/icon.svg").success).toBe(true);
    for (const unsafe of [
      "http://example.com/icon.svg",
      "https://user:secret@example.com/icon.svg",
      "javascript:alert(1)",
      "file:///tmp/icon.svg",
      "/assets/remix-icon/unrecorded.svg",
      "not a URL",
    ]) {
      expect(ServiceIconUrlSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it("defaults service probes to a five-second interval", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();

    expect(snapshot.serviceProbePolicy.intervalSeconds).toBe(5);
  });

  it("keeps group selections scoped to group membership", async () => {
    const client = new FixtureStatusClient();
    await expect(client.selectGroupChild("streaming", "hkg-01")).rejects.toThrow(
      "does not belong to this group",
    );

    const next = await client.selectGroupChild("streaming", "nrt-03");
    expect(next.groups.find((group) => group.id === "streaming")?.selectedChildId).toBe("nrt-03");
    expect(next.groups.find((group) => group.id === "proxy")?.selectedChildId).toBe("hkg-02");
  });

  it("allows selection only inside selector groups", async () => {
    const client = new FixtureStatusClient();
    await expect(client.selectGroupChild("auto-fast", "sin-01")).rejects.toThrow(
      "group is not a selector",
    );

    const next = await client.selectGroupChild("proxy", "auto-fast");
    expect(next.groups.find((group) => group.id === "proxy")?.selectedChildId).toBe("auto-fast");
    expect(next.groups.find((group) => group.id === "auto-fast")?.selectedChildId).toBe("nrt-03");
  });

  it("models capture actions as fixture state only", async () => {
    const client = new FixtureStatusClient();
    const selection = { systemProxy: true, tun: false };
    const stopped = await client.setCapture(selection, false);
    expect(stopped.runtime.phase).toBe("inactive");
    expect(stopped.runtime.captureSelection).toEqual(selection);
    expect(stopped.capabilities.systemProxy).toBe("fixture-only");

    const started = await client.setCapture(selection, true);
    expect(started.runtime).toMatchObject({
      phase: "healthy",
      systemProxyEnabled: true,
      tunEnabled: false,
    });
  });

  it("does not enable System Proxy when a profile is selected", async () => {
    const client = new FixtureStatusClient();

    const next = await client.setActiveProfile("work");

    expect(next.activeProfileId).toBe("work");
    expect(next.runtime.captureSelection.systemProxy).toBe(false);
    expect(next.runtime.systemProxyEnabled).toBe(false);
    expect(next.runtime.systemProxy.phase).toBe("off");
  });
});
