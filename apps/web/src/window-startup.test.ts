import { describe, expect, it, vi } from "vitest";
import { createDesktopStartupPlaceholderReveal } from "./window-startup";

function createDependencies(buildTarget: string | undefined = "desktop") {
  return {
    buildTarget,
    scheduleFrame: vi.fn<(callback: FrameRequestCallback) => number>(),
    signalWindowReady: vi.fn().mockResolvedValue(undefined),
  };
}

describe("desktop startup placeholder reveal", () => {
  it("schedules reveal without waiting on hidden WebView image decoding", async () => {
    const dependencies = createDependencies();
    const revealPlaceholder = createDesktopStartupPlaceholderReveal(dependencies);

    revealPlaceholder();

    expect(dependencies.signalWindowReady).not.toHaveBeenCalled();
    const frameCallback = dependencies.scheduleFrame.mock.calls[0]?.[0];
    expect(frameCallback).toBeTypeOf("function");

    frameCallback?.(0);
    await Promise.resolve();

    expect(dependencies.signalWindowReady).toHaveBeenCalledOnce();
  });

  it("does not schedule a desktop reveal for the mobile build", () => {
    const dependencies = createDependencies("mobile");
    const revealPlaceholder = createDesktopStartupPlaceholderReveal(dependencies);

    revealPlaceholder();

    expect(dependencies.scheduleFrame).not.toHaveBeenCalled();
    expect(dependencies.signalWindowReady).not.toHaveBeenCalled();
  });

  it("keeps the desktop demo eligible for its native reveal guard", () => {
    const dependencies = createDependencies(undefined);
    const revealPlaceholder = createDesktopStartupPlaceholderReveal(dependencies);

    revealPlaceholder();

    expect(dependencies.scheduleFrame).toHaveBeenCalledOnce();
  });
});
