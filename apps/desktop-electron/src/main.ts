import {
  net,
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTENT_SECURITY_POLICY,
  createRendererPolicy,
  denyWindowOpen,
  HARDENED_WEB_PREFERENCES,
  isAllowedRendererUrl,
  MISH_PROTOCOL,
  MISH_PROTOCOL_HOST,
  parseDevelopmentOrigin,
  type RendererPolicy,
} from "./security";
import { resolveMishAsset } from "./protocol";
import {
  electronShellInfo,
  IpcRouter,
  IPC_CHANNELS,
  LifecycleTranscript,
  type IpcChannel,
} from "./ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: MISH_PROTOCOL,
    privileges: {
      corsEnabled: false,
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

type RendererTarget =
  | { kind: "custom-protocol"; url: string }
  | { kind: "development-url"; url: string };

function resolveWebRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.resolve(__dirname, "../../web/dist");
}

function resolveRendererTarget(webRoot: string): RendererTarget {
  const developmentOrigin = parseDevelopmentOrigin(process.env.MISH_ELECTRON_WEB_URL);
  if (developmentOrigin) return { kind: "development-url", url: `${developmentOrigin}/` };
  const index = path.join(webRoot, "index.html");
  if (!existsSync(index)) {
    throw new Error("Electron renderer bundle is missing; build @mish/web first");
  }
  return { kind: "custom-protocol", url: `${MISH_PROTOCOL}://${MISH_PROTOCOL_HOST}/` };
}

class ElectronHostLifecycle {
  readonly #windows = new Set<BrowserWindow>();
  readonly #windowDisposers = new Map<BrowserWindow, () => void>();
  readonly #lifecycle = new LifecycleTranscript();
  readonly #router = new IpcRouter({
    getShellInfo: electronShellInfo,
    lifecycle: this.#lifecycle,
  });
  readonly #webRoot: string;
  readonly #policy: RendererPolicy;
  readonly #rendererTarget: RendererTarget;
  #disposed = false;
  #protocolInstalled = false;
  #ipcRegistered = false;

  constructor() {
    this.#webRoot = resolveWebRoot();
    this.#rendererTarget = resolveRendererTarget(this.#webRoot);
    this.#policy = createRendererPolicy(
      this.#webRoot,
      this.#rendererTarget.kind === "development-url"
        ? new URL(this.#rendererTarget.url).origin
        : null,
    );
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error("Electron host is disposed");
    this.installRendererProtocol();
    this.registerIpc();
    this.installSessionPolicy();
    await this.createWindow();
  }

  async createWindow(): Promise<void> {
    if (this.#disposed) return;
    const existing = [...this.#windows].find((window) => !window.isDestroyed());
    if (existing) {
      existing.show();
      existing.focus();
      return;
    }

    const window = new BrowserWindow({
      backgroundColor: "#f8f9fa",
      minHeight: 600,
      minWidth: 800,
      show: false,
      title: "Mish",
      webPreferences: {
        ...HARDENED_WEB_PREFERENCES,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    this.trackWindow(window);
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedRendererUrl(url, this.#policy)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedRendererUrl(url, this.#policy)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => denyWindowOpen());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => {
      try {
        this.#lifecycle.record("renderer-destroyed");
      } catch {
        // The bounded transcript is diagnostic evidence; it cannot own recovery.
      }
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("closed", () => this.untrackWindow(window));

    await window.loadURL(this.#rendererTarget.url);
  }

  focusWindow(): void {
    const window = [...this.#windows].find((candidate) => !candidate.isDestroyed());
    if (!window) return;
    window.show();
    window.focus();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (this.#ipcRegistered) ipcMain.removeHandler(channel);
    }
    this.#ipcRegistered = false;
    if (this.#protocolInstalled) {
      protocol.unhandle(MISH_PROTOCOL);
      this.#protocolInstalled = false;
    }
    for (const [window, dispose] of this.#windowDisposers) {
      dispose();
      if (!window.isDestroyed()) window.destroy();
    }
    this.#windowDisposers.clear();
    this.#windows.clear();
  }

  private installRendererProtocol(): void {
    if (this.#protocolInstalled) return;
    protocol.handle(MISH_PROTOCOL, async (request) => {
      const asset = resolveMishAsset(request.url, this.#policy);
      if (!asset) return new Response("Not found", { status: 404 });
      try {
        return await net.fetch(pathToFileURL(asset).toString());
      } catch {
        return new Response("Renderer asset unavailable", { status: 404 });
      }
    });
    this.#protocolInstalled = true;
  }

  private installSessionPolicy(): void {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    defaultSession.setPermissionCheckHandler(() => false);
    defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (!isAllowedRendererUrl(details.url, this.#policy)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
          "Permissions-Policy": ["camera=(), geolocation=(), microphone=(), usb=()"],
        },
      });
    });
  }

  private registerIpc(): void {
    if (this.#ipcRegistered) return;
    const channels = Object.values(IPC_CHANNELS) as readonly IpcChannel[];
    for (const channel of channels) {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) =>
        this.#router.invoke(channel, payload, { senderTrusted: this.isTrustedSender(event) }),
      );
    }
    this.#ipcRegistered = true;
  }

  private isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(
      window &&
      this.#windows.has(window) &&
      !window.isDestroyed() &&
      event.senderFrame !== null &&
      isAllowedRendererUrl(event.senderFrame.url, this.#policy),
    );
  }

  private trackWindow(window: BrowserWindow): void {
    this.#windows.add(window);
    this.#windowDisposers.set(window, () => {
      this.#windows.delete(window);
    });
  }

  private untrackWindow(window: BrowserWindow): void {
    this.#windowDisposers.get(window)?.();
    this.#windowDisposers.delete(window);
    this.#windows.delete(window);
  }
}

let host: ElectronHostLifecycle | null = null;
const ownsInstance = app.requestSingleInstanceLock();

if (!ownsInstance) {
  app.quit();
} else {
  app.on("second-instance", () => host?.focusWindow());
  app.on("before-quit", () => host?.dispose());
  app.on("activate", () => void host?.createWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void app
    .whenReady()
    .then(() => {
      host = new ElectronHostLifecycle();
      return host.start();
    })
    .catch(() => {
      host?.dispose();
      app.quit();
    });
}
