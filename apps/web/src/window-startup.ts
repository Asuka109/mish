import { signalDesktopWindowReady } from "./platform/desktop-window";

interface DesktopStartupPlaceholderDependencies {
  buildTarget: string | undefined;
  scheduleFrame(callback: FrameRequestCallback): number;
  signalWindowReady(): Promise<void>;
}

const defaultDependencies: DesktopStartupPlaceholderDependencies = {
  buildTarget: import.meta.env.VITE_MISH_BUILD_TARGET,
  scheduleFrame: (callback) => requestAnimationFrame(callback),
  signalWindowReady: signalDesktopWindowReady,
};

export function createDesktopStartupPlaceholderReveal(
  dependencies: DesktopStartupPlaceholderDependencies = defaultDependencies,
) {
  return function revealDesktopStartupPlaceholder() {
    if (dependencies.buildTarget === "mobile") return;

    dependencies.scheduleFrame(() => {
      void dependencies.signalWindowReady().catch(() => undefined);
    });
  };
}

export const revealDesktopStartupPlaceholder = createDesktopStartupPlaceholderReveal();

revealDesktopStartupPlaceholder();
