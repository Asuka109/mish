import type { ServiceProbeResultDto } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { classifyServiceLatency } from "./service-monitor-section";

function result(
  latencyMilliseconds: number | null,
  status: ServiceProbeResultDto["status"] = "healthy",
): ServiceProbeResultDto {
  return {
    latencyMilliseconds,
    monitorId: "google",
    observedAt: "2026-07-21T12:00:00Z",
    routeTarget: "fixture-only",
    status,
  };
}

describe("classifyServiceLatency", () => {
  it.each([
    [999, "success"],
    [1000, "success"],
    [1001, "warning"],
    [10_000, "warning"],
  ] as const)("classifies a successful %ims measurement as %s", (latency, status) => {
    expect(classifyServiceLatency(result(latency), false)).toBe(status);
  });

  it("keeps pending results neutral and gives failures precedence over slow latency", () => {
    expect(classifyServiceLatency(undefined, false)).toBe("pending");
    expect(classifyServiceLatency(result(null, "pending"), false)).toBe("pending");
    expect(classifyServiceLatency(result(1001, "error"), false)).toBe("error");
    expect(classifyServiceLatency(result(1001), true)).toBe("error");
  });
});
