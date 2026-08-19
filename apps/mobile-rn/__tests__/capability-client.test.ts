import {
  CAPABILITY_NAMES,
  createCapabilityClient,
  parseCapabilityResult,
  parseCapabilitySnapshot,
} from "../src/native/capability-client";

jest.mock("../src/native/NativeMishCapability", () => ({
  __esModule: true,
  default: null,
}));

const snapshot = JSON.stringify({
  contractVersion: 1,
  state: "unavailable",
  capabilities: CAPABILITY_NAMES,
  message: "Native platform effects are unavailable in this foundation build.",
});

const result = JSON.stringify({
  contractVersion: 1,
  capability: "vpn",
  requestId: "test-1",
  state: "unavailable",
  reason: "not-implemented",
  message: "Native platform effects are unavailable in this foundation build.",
});

test("accepts the closed foundation snapshot and result schemas", () => {
  expect(parseCapabilitySnapshot(snapshot).capabilities).toEqual([...CAPABILITY_NAMES]);
  expect(parseCapabilityResult(result)).toMatchObject({
    capability: "vpn",
    requestId: "test-1",
    state: "unavailable",
  });
});

test("rejects unknown fields, unknown capabilities, and oversized native responses", () => {
  expect(() =>
    parseCapabilitySnapshot(
      JSON.stringify({ ...JSON.parse(snapshot), privatePath: "/tmp/secret" }),
    ),
  ).toThrow("malformed-native-response");
  expect(() =>
    parseCapabilityResult(JSON.stringify({ ...JSON.parse(result), capability: "arbitrary" })),
  ).toThrow("malformed-native-response");
  expect(() => parseCapabilitySnapshot("x".repeat(4_097))).toThrow("native-response-too-large");
});

test("validates request identity before invoking the native seam", async () => {
  let invocations = 0;
  const client = createCapabilityClient({
    getSnapshot: async () => snapshot,
    requestCapability: async () => {
      invocations += 1;
      return result;
    },
  });

  await expect(client.requestCapability("vpn", "invalid request" as never)).resolves.toMatchObject({
    reason: "invalid-input",
  });
  await expect(client.requestCapability("vpn", "test-1")).resolves.toMatchObject({
    capability: "vpn",
    requestId: "test-1",
  });
  expect(invocations).toBe(1);
});

test("returns an unavailable projection when the module is absent or malformed", async () => {
  await expect(createCapabilityClient(null).getSnapshot()).resolves.toMatchObject({
    state: "unavailable",
  });
  await expect(
    createCapabilityClient(null).requestCapability("vpn", "test-1"),
  ).resolves.toMatchObject({
    capability: "vpn",
    requestId: "test-1",
    state: "unavailable",
    reason: "not-implemented",
  });
  await expect(
    createCapabilityClient({
      getSnapshot: async () => "{}",
      requestCapability: async () => "{}",
    }).requestCapability("vpn", "test-1"),
  ).resolves.toMatchObject({ reason: "malformed-native-response" });
});
