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
  it("reveals without waiting on hidden WebView animation frames", async () => {
    const dependencies = createDependencies();
    const revealPlaceholder = createDesktopStartupPlaceholderReveal(dependencies);

    revealPlaceholder();
    await Promise.resolve();

    expect(dependencies.signalWindowReady).toHaveBeenCalledOnce();
    expect(dependencies.scheduleFrame).not.toHaveBeenCalled();
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

    expect(dependencies.signalWindowReady).toHaveBeenCalledOnce();
  });
});
