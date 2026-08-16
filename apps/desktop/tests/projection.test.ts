import { describe, expect, it } from "vitest";

import {
  createElectronProjectionAuthority,
  type ElectronProjectionRequest,
} from "../src/projection.js";

const session = { generation: 1, parentEpoch: 1, revision: 1 } as const;

function request(
  operation: string,
  overrides: Partial<ElectronProjectionRequest> = {},
): ElectronProjectionRequest {
  return {
    correlationId: "orpc-correlation-0001",
    deadlineMs: 250,
    operation,
    parentEpoch: session.parentEpoch,
    revision: session.revision,
    sessionGeneration: session.generation,
    ...overrides,
  };
}

describe("Electron product projection authority", () => {
  it("returns operation-matched typed data without fabricating user records", () => {
    const authority = createElectronProjectionAuthority();
    authority.setSession(session);
    authority.setAvailable();

    const status = authority.invoke(request("status.snapshot"));
    expect(status.operation).toBe("status.snapshot");
    expect(status.result).toBe("projection-ready");
    expect(status.data).toEqual({
      activeConnections: 0,
      downloadBytesPerSecond: 0,
      kind: "status",
      phase: "ready",
      profileName: null,
      uploadBytesPerSecond: 0,
    });

    const routes = authority.invoke(request("routes.snapshot"));
    expect(routes.data).toEqual({ kind: "routes", groups: [] });
    const profiles = authority.invoke(request("profile.refresh"));
    expect(profiles.data).toEqual({ kind: "profiles", profiles: [] });
    const traffic = authority.invoke(request("traffic.snapshot"));
    expect(traffic.data).toEqual({ kind: "traffic", connections: [], rules: [] });
    const events = authority.invoke(request("events.snapshot"));
    expect(events.data).toEqual({ kind: "events", events: [] });
    const settings = authority.invoke(request("settings.snapshot"));
    expect(settings.result).toBe("projection-owned");
    expect(settings.data).toEqual({
      appearance: "system",
      kind: "settings",
      language: "en",
      readOnly: true,
    });

    const serialized = JSON.stringify([
      status.data,
      routes.data,
      profiles.data,
      traffic.data,
      events.data,
      settings.data,
    ]);
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("authToken");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("127.0.0.1");
  });

  it("reports current availability and keeps owned settings explicit", () => {
    const authority = createElectronProjectionAuthority({
      settings: { appearance: "dark", language: "zh-CN" },
    });
    authority.setSession(session);

    const unavailable = authority.invoke(request("status.snapshot"));
    expect(unavailable.result).toBe("projection-unavailable");
    expect(unavailable.data).toMatchObject({ kind: "status", phase: "unavailable" });

    authority.setAvailable();
    expect(authority.invoke(request("settings.snapshot")).data).toEqual({
      appearance: "dark",
      kind: "settings",
      language: "zh-CN",
      readOnly: true,
    });
  });

  it("rejects invalid, stale, deadline, cancelled, and disposed requests", () => {
    const authority = createElectronProjectionAuthority();
    authority.setSession(session);
    authority.setAvailable();
    const invoke = (overrides: Partial<ElectronProjectionRequest>) =>
      authority.invoke(request("status.snapshot", overrides));

    expect(() => invoke({ operation: "unknown.operation" })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
    expect(() => invoke({ correlationId: "electron-0001" })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
    expect(() => invoke({ deadlineMs: 0 })).toThrowError(
      expect.objectContaining({ code: "TIMEOUT", status: 408 }),
    );
    expect(() => invoke({ deadlineMs: 1_001 })).toThrowError(
      expect.objectContaining({ code: "TIMEOUT", status: 408 }),
    );
    expect(() => invoke({ sessionGeneration: 2 })).toThrowError(
      expect.objectContaining({ code: "CONFLICT", status: 409 }),
    );
    expect(() => invoke({ parentEpoch: 2 })).toThrowError(
      expect.objectContaining({ code: "CONFLICT", status: 409 }),
    );
    expect(() => invoke({ revision: 2 })).toThrowError(
      expect.objectContaining({ code: "CONFLICT", status: 409 }),
    );

    const controller = new AbortController();
    controller.abort();
    expect(() => authority.invoke(request("status.snapshot"), controller.signal)).toThrowError(
      expect.objectContaining({ code: "CLIENT_CLOSED_REQUEST", status: 499 }),
    );

    authority.dispose();
    expect(authority.available).toBe(false);
    expect(authority.disposed).toBe(true);
    expect(() => invoke({})).toThrowError(
      expect.objectContaining({ code: "DISPOSED", status: 410 }),
    );
  });

  it("resets availability on a new session generation without replacing the authority", () => {
    const authority = createElectronProjectionAuthority();
    authority.setSession(session);
    authority.setAvailable();
    const first = authority.invoke(request("status.snapshot"));

    authority.setSession({ generation: 2, parentEpoch: 2, revision: 2 });
    expect(authority.available).toBe(false);
    expect(authority.session).toEqual({ generation: 2, parentEpoch: 2, revision: 2 });
    expect(() => authority.invoke(request("status.snapshot"))).toThrowError(
      expect.objectContaining({ code: "CONFLICT", status: 409 }),
    );
    const second = authority.invoke({
      ...request("status.snapshot"),
      parentEpoch: 2,
      revision: 2,
      sessionGeneration: 2,
    });
    expect(first.data).not.toBe(second.data);
    expect(second.data).toMatchObject({ phase: "unavailable" });
  });
});
