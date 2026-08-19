/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MISH_BUILD_TARGET?: "desktop" | "mobile";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Narrow Electron host surface supplied by preload when the Web bundle runs in Electron. */
  mishElectron?: {
    getShellInfo(): Promise<{
      schemaVersion: 1;
      runtime: "electron";
      backend: "unavailable";
      capabilities: {
        core: "unavailable";
        helper: "unavailable";
        systemProxy: "unavailable";
        tun: "unavailable";
        updater: "unavailable";
      };
    }>;
    recordLifecycle(
      event: "renderer-ready" | "renderer-page-hidden" | "renderer-destroyed",
    ): Promise<{
      event: "renderer-ready" | "renderer-page-hidden" | "renderer-destroyed";
      sequence: number;
    }>;
  };
}
