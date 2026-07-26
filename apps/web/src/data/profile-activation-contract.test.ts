import {
  ProfileActivationSnapshotSchema,
  type ProfileActivationSnapshotDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";

const fingerprint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const profileId = "profile-a";

function idleActivation(): ProfileActivationSnapshotDto {
  return {
    activeFingerprint: null,
    activeProfileId: null,
    attemptedAt: null,
    availability: "available",
    commandId: null,
    evidence: null,
    failure: null,
    failureEndpoint: null,
    operation: null,
    phase: "idle",
    safeStopped: true,
    startupPolicy: "safe-stopped",
    targetProfileId: null,
  };
}

function pendingActivation(
  operation: "activate" | "stop" = "activate",
): ProfileActivationSnapshotDto {
  return {
    ...idleActivation(),
    activeFingerprint: operation === "stop" ? fingerprint : null,
    activeProfileId: operation === "stop" ? profileId : null,
    attemptedAt: 1,
    commandId: "command-a",
    operation,
    phase: "pending",
    safeStopped: operation !== "stop",
    targetProfileId: profileId,
  };
}

describe("Profile activation contract", () => {
  it("accepts every legal public projection boundary", () => {
    const pending = pendingActivation();
    const stopPending = pendingActivation("stop");
    const variants: ProfileActivationSnapshotDto[] = [
      idleActivation(),
      { ...idleActivation(), availability: "unavailable" },
      pending,
      {
        ...pending,
        evidence: { asset: "geo-site", kind: "geodata-preparing" },
      },
      {
        ...pending,
        activeFingerprint: fingerprint,
        activeProfileId: profileId,
        phase: "success",
        safeStopped: false,
      },
      { ...pending, failure: "validation", phase: "failure" },
      { ...pending, failure: "cancelled", phase: "failure" },
      {
        ...pending,
        evidence: { asset: "geo-ip", kind: "geodata-failed" },
        failure: "geodata-failed",
        phase: "failure",
      },
      {
        ...pending,
        failure: "managed-listener-conflict",
        failureEndpoint: "127.0.0.1:7890",
        phase: "failure",
      },
      { ...pending, failure: "capture", phase: "failure" },
      {
        ...pending,
        activeFingerprint: fingerprint,
        activeProfileId: profileId,
        failure: "capture",
        phase: "failure",
        safeStopped: false,
      },
      stopPending,
      {
        ...stopPending,
        activeFingerprint: null,
        activeProfileId: null,
        phase: "success",
        safeStopped: true,
      },
      { ...stopPending, failure: "prior-stop", phase: "failure" },
    ];

    for (const variant of variants) {
      expect(ProfileActivationSnapshotSchema.safeParse(variant).success).toBe(true);
    }
  });

  it.each([
    ["pending without command", { ...pendingActivation(), commandId: null }],
    ["pending without target", { ...pendingActivation(), targetProfileId: null }],
    ["pending with failure", { ...pendingActivation(), failure: "validation" }],
    [
      "pending with terminal evidence",
      {
        ...pendingActivation(),
        evidence: { asset: "geo-site", kind: "geodata-failed" as const },
      },
    ],
    [
      "pending stop with preparation evidence",
      {
        ...pendingActivation("stop"),
        evidence: { asset: "geo-site", kind: "geodata-preparing" as const },
      },
    ],
    [
      "success with failure",
      {
        ...pendingActivation(),
        activeFingerprint: fingerprint,
        activeProfileId: profileId,
        failure: "validation" as const,
        phase: "success" as const,
        safeStopped: false,
      },
    ],
    [
      "success for another target",
      {
        ...pendingActivation(),
        activeFingerprint: fingerprint,
        activeProfileId: "profile-b",
        phase: "success" as const,
        safeStopped: false,
      },
    ],
    ["failure without evidence", { ...pendingActivation(), phase: "failure" as const }],
    [
      "mismatched geodata evidence",
      {
        ...pendingActivation(),
        evidence: { asset: "geo-site", kind: "geodata-timeout" as const },
        failure: "geodata-failed" as const,
        phase: "failure" as const,
      },
    ],
    [
      "stop with geodata failure evidence",
      {
        ...pendingActivation("stop"),
        evidence: { asset: "geo-site", kind: "geodata-failed" as const },
        failure: "geodata-failed" as const,
        phase: "failure" as const,
      },
    ],
    [
      "listener failure without endpoint",
      {
        ...pendingActivation(),
        failure: "managed-listener-conflict" as const,
        phase: "failure" as const,
      },
    ],
    [
      "unrelated failure with endpoint",
      {
        ...pendingActivation(),
        failure: "validation" as const,
        failureEndpoint: "127.0.0.1:7890",
        phase: "failure" as const,
      },
    ],
    [
      "safe runtime with active Profile",
      {
        ...idleActivation(),
        activeFingerprint: fingerprint,
        activeProfileId: profileId,
      },
    ],
    [
      "active runtime without fingerprint",
      {
        ...pendingActivation(),
        activeProfileId: profileId,
        safeStopped: false,
      },
    ],
    [
      "idle with command",
      {
        ...idleActivation(),
        attemptedAt: 1,
        commandId: "command-a",
        operation: "activate" as const,
        targetProfileId: profileId,
      },
    ],
    ["successful stop with active runtime", { ...pendingActivation("stop"), phase: "success" }],
  ])("rejects %s", (_label, activation) => {
    expect(ProfileActivationSnapshotSchema.safeParse(activation).success).toBe(false);
  });
});
