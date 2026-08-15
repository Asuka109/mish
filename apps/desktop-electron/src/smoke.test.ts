import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HARDENED_WEB_PREFERENCES,
  CONTENT_SECURITY_POLICY,
  createRendererPolicy,
  denyWindowOpen,
  isAllowedRendererUrl,
  parseDevelopmentOrigin,
} from "./security";
import { resolveMishAsset } from "./protocol";
import {
  electronShellInfo,
  IpcError,
  IpcRouter,
  IPC_CHANNELS,
  LifecycleTranscript,
  MAX_IPC_PAYLOAD_BYTES,
  MAX_LIFECYCLE_EVENTS,
  ShellInfoSchema,
} from "./ipc";

const sourceRoot = path.resolve(__dirname, "..", "src");

function expectIpcError(action: () => unknown, code: IpcError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof IpcError && error.code === code);
}

test("renderer policy accepts only the custom app origin and exact loopback dev origin", () => {
  const webRoot = mkdtempSync(path.join(tmpdir(), "mish-electron-web-"));
  mkdirSync(path.join(webRoot, "assets"));
  writeFileSync(path.join(webRoot, "index.html"), "fixture");
  writeFileSync(path.join(webRoot, "assets", "main.js"), "fixture");
  const policy = createRendererPolicy(webRoot, "http://127.0.0.1:4173");

  assert.equal(isAllowedRendererUrl("mish://app/index.html", policy), true);
  assert.equal(isAllowedRendererUrl("mish://app/", policy), true);
  assert.equal(isAllowedRendererUrl("mish://app/assets/main.js", policy), true);
  assert.equal(isAllowedRendererUrl("mish://app/../secret", policy), false);
  assert.equal(isAllowedRendererUrl("https://127.0.0.1:4173/", policy), false);
  assert.equal(isAllowedRendererUrl("http://localhost:4173/", policy), false);
  assert.equal(isAllowedRendererUrl("http://user:pass@127.0.0.1:4173/", policy), false);
  assert.equal(isAllowedRendererUrl("http://127.0.0.1:4173/", policy), true);
  assert.equal(isAllowedRendererUrl("http://127.0.0.1:4173/?token=secret", policy), true);
  assert.equal(isAllowedRendererUrl("http://127.0.0.1:4174/", policy), false);
  assert.equal(isAllowedRendererUrl("mish://app:123/index.html", policy), false);
});

test("custom protocol resolves SPA routes and rejects symlink/path escape", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mish-electron-protocol-"));
  const webRoot = path.join(temporary, "web");
  const outside = path.join(temporary, "outside.txt");
  mkdirSync(path.join(webRoot, "assets"), { recursive: true });
  writeFileSync(path.join(webRoot, "index.html"), "index");
  writeFileSync(outside, "outside");
  symlinkSync(outside, path.join(webRoot, "assets", "outside.txt"));
  const policy = createRendererPolicy(webRoot);

  assert.equal(
    resolveMishAsset("mish://app/index.html", policy),
    realpathSync(path.join(webRoot, "index.html")),
  );
  assert.equal(
    resolveMishAsset("mish://app/settings", policy),
    realpathSync(path.join(webRoot, "index.html")),
  );
  assert.equal(resolveMishAsset("mish://app/assets/outside.txt", policy), null);
  assert.equal(resolveMishAsset("mish://app/%2e%2e/outside.txt", policy), null);
});

test("development origin parsing stays credential-free and IPv4-loopback-only", () => {
  assert.equal(parseDevelopmentOrigin(undefined), null);
  assert.equal(parseDevelopmentOrigin("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
  assert.throws(() => parseDevelopmentOrigin("https://127.0.0.1:4173"));
  assert.throws(() => parseDevelopmentOrigin("http://localhost:4173"));
  assert.throws(() => parseDevelopmentOrigin("http://127.0.0.1:4173/path"));
  assert.throws(() => parseDevelopmentOrigin("http://user:pass@127.0.0.1:4173"));
});

test("Electron security defaults and navigation policy fail closed", () => {
  assert.deepEqual(HARDENED_WEB_PREFERENCES, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
  assert.equal(denyWindowOpen().action, "deny");
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/u);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/u);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/u);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /https?:\/\/[^\s;]+/u);
});

test("IPC is typed, sender-bound, allowlisted, and bounded", () => {
  const lifecycle = new LifecycleTranscript();
  const router = new IpcRouter({ getShellInfo: electronShellInfo, lifecycle });
  assert.deepEqual(router.invoke(IPC_CHANNELS.getShellInfo, {}, { senderTrusted: true }), {
    schemaVersion: 1,
    runtime: "electron",
    backend: "unavailable",
    capabilities: {
      core: "unavailable",
      helper: "unavailable",
      systemProxy: "unavailable",
      tun: "unavailable",
      updater: "unavailable",
    },
  });
  assert.doesNotThrow(() => ShellInfoSchema.parse(electronShellInfo()));
  assert.deepEqual(
    router.invoke(
      IPC_CHANNELS.recordLifecycle,
      { event: "renderer-ready" },
      { senderTrusted: true },
    ),
    { event: "renderer-ready", sequence: 1 },
  );
  expectIpcError(
    () => router.invoke("mish.unknown", {}, { senderTrusted: true }),
    "channel-not-allowed",
  );
  expectIpcError(
    () => router.invoke(IPC_CHANNELS.getShellInfo, {}, { senderTrusted: false }),
    "sender-untrusted",
  );
  expectIpcError(
    () =>
      router.invoke(
        IPC_CHANNELS.getShellInfo,
        { padding: "x".repeat(MAX_IPC_PAYLOAD_BYTES) },
        { senderTrusted: true },
      ),
    "payload-too-large",
  );
  expectIpcError(
    () => router.invoke(IPC_CHANNELS.getShellInfo, { unexpected: true }, { senderTrusted: true }),
    "payload-invalid",
  );
});

test("lifecycle transcript is deterministic and has an explicit overflow result", () => {
  const transcript = new LifecycleTranscript();
  for (let index = 0; index < MAX_LIFECYCLE_EVENTS; index += 1) {
    transcript.record("renderer-page-hidden");
  }
  assert.equal(transcript.snapshot().length, MAX_LIFECYCLE_EVENTS);
  assert.equal(transcript.snapshot()[0]?.sequence, 1);
  assert.equal(transcript.snapshot().at(-1)?.sequence, MAX_LIFECYCLE_EVENTS);
  expectIpcError(() => transcript.record("renderer-ready"), "lifecycle-overflow");
});

test("host source keeps the renderer boundary and unavailable capability truth", () => {
  const mainSource = readFileSync(path.join(sourceRoot, "main.ts"), "utf8");
  const preloadSource = readFileSync(path.join(sourceRoot, "preload.ts"), "utf8");
  assert.match(mainSource, /HARDENED_WEB_PREFERENCES/u);
  assert.match(mainSource, /setWindowOpenHandler/u);
  assert.match(mainSource, /will-navigate/u);
  assert.match(mainSource, /will-attach-webview/u);
  assert.doesNotMatch(mainSource, /shell\.openExternal/u);
  assert.doesNotMatch(mainSource, /Mihomo|System Proxy|TUN|Helper|updater/u);
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\("mishElectron"/u);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^,]+,\s*ipcRenderer/u);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.sendToHost|ipcRenderer\.on/u);
});
