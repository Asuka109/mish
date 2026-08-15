import { describe, expect, it } from "vitest";

import { verifyElectronArchive } from "../src/archive.ts";
import { correlation, ElectronTranscript } from "../src/transcript.ts";

describe("Electron admission transcript and archive gates", () => {
  it("keeps synthetic transcript evidence bounded and privacy-safe", () => {
    const transcript = new ElectronTranscript(2);
    transcript.record({
      operation: "window.create",
      effect: "invocation",
      result: "accepted",
      correlationId: correlation(1),
    });
    transcript.record({
      operation: "renderer.bootstrap",
      effect: "result",
      result: "ready",
      correlationId: correlation(2),
    });
    transcript.record({
      operation: "application.quit",
      effect: "result",
      result: "quit",
      correlationId: correlation(3),
    });
    expect(transcript.snapshot()).toHaveLength(2);
    expect(transcript.snapshot()[0]?.schemaVersion).toBe(1);
    expect(transcript.serialize()).not.toContain("fixture-token");
    expect(() =>
      transcript.record({
        operation: "window.create",
        effect: "result",
        result: "accepted",
        correlationId: "real-path",
      }),
    ).toThrow();
  });

  it("fails closed for a missing or tampered Electron archive", () => {
    expect(() => verifyElectronArchive("/definitely/missing/electron.zip")).toThrow(/missing/);
    const archive = process.env.MISH_ELECTRON_ARCHIVE;
    if (!archive) return;
    expect(() => verifyElectronArchive(archive, "0".repeat(64))).toThrow(/SHA-256 mismatch/);
  });
});
