import { page } from "vitest/browser";
import { describe, expect, test, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Outlet } from "react-router";
import { ProductRoutes } from "../app-routes";
import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import {
  BrowserAuthenticationRequired,
  BrowserBootstrapUnavailable,
  consumeBrowserLaunchTokenFromLocation,
  resolveStartupStatusClient,
} from "./runtime-bootstrap";

const authToken = "0123456789abcdef".repeat(4);
const supportBundleDependencies = {
  invokeCommitLocalRestore: vi.fn(),
  invokeLocalBackupPreview: vi.fn(),
  invokeLocalBackupSave: vi.fn(),
  invokeLocalRestorePreview: vi.fn(),
  invokeSupportBundlePreview: vi.fn(),
  invokeSupportBundleSave: vi.fn(),
};

function successfulBootstrap() {
  return {
    authToken,
    localBackup: false,
    rpcUrl: "ws://127.0.0.1:43123/rpc",
    settingsSnapshot: {
      ...createFixtureSettingsSnapshot(),
      adapterKind: "rpc" as const,
    },
    supportBundleExport: false,
  };
}

function routeElement(label: string) {
  return <main data-testid="authenticated-route">{label}</main>;
}

async function authenticateAndRender(path: string, expectedPath: string, expectedLabel: string) {
  const launchToken = crypto.randomUUID().replaceAll("-", "").padEnd(43, "a").slice(0, 43);
  window.history.replaceState({ source: "browser-test" }, "", `${path}#token=${launchToken}`);
  const events: string[] = [];

  const startup = await resolveStartupStatusClient({
    browserBootstrap: {
      clearProof: vi.fn(),
      consumeLaunchToken: () => {
        events.push("consume");
        return consumeBrowserLaunchTokenFromLocation(window.location, {
          replaceState: (state, title, url) => {
            events.push("replace");
            window.history.replaceState(state, title, url);
          },
          state: window.history.state,
        });
      },
      createProof: () => "d".repeat(64),
      fetch: async (token, proof) => {
        events.push("fetch");
        expect(token).toBe(launchToken);
        expect(proof).toBe("d".repeat(64));
        return successfulBootstrap();
      },
      loadProof: () => null,
      saveProof: vi.fn(),
    },
    demoMode: false,
    invokeBootstrap: vi.fn(),
    invokeLocalProfilePreflight: vi.fn(),
    ...supportBundleDependencies,
    isDesktop: () => false,
    openWebSocket: vi.fn(),
  });

  expect(events).toEqual(["consume", "replace", "fetch"]);
  expect(window.location.hash).toBe("");
  expect(window.location.pathname + window.location.search).toBe(path === "/" ? "/" : path);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    <BrowserRouter>
      <ProductRoutes
        routesElement={routeElement("Routes")}
        settingsElement={routeElement("Settings")}
        shell={<Outlet />}
        statusElement={routeElement("Status")}
      />
    </BrowserRouter>,
  );

  await expect.element(page.getByTestId("authenticated-route")).toHaveTextContent(expectedLabel);
  expect(window.location.pathname + window.location.search).toBe(expectedPath);

  root.unmount();
  container.remove();
  startup.dispose();
}

describe("Browser Client launch startup in Chromium", () => {
  test("authenticates before the root redirect and reaches Status with a fragment-free history entry", async () => {
    await authenticateAndRender("/", "/status", "Status");
  });

  test.each([
    ["/routes?sort=latency", "Routes"],
    ["/settings?section=application", "Settings"],
  ])("preserves direct authenticated route %s", async (path, label) => {
    await authenticateAndRender(path, path, label);
  });

  test.each([
    ["replayed", `#token=${"r".repeat(43)}`],
    ["invalid", "#token=short"],
  ])(
    "cleans a %s token and falls back to browser authentication after rejection",
    async (_case, hash) => {
      window.history.replaceState(null, "", `/routes${hash}`);
      const clearProof = vi.fn();
      const fetchBootstrap = vi.fn(async () => {
        throw new BrowserBootstrapUnavailable(401);
      });

      await expect(
        resolveStartupStatusClient({
          browserBootstrap: {
            clearProof,
            consumeLaunchToken: () =>
              consumeBrowserLaunchTokenFromLocation(window.location, window.history),
            createProof: () => "e".repeat(64),
            fetch: fetchBootstrap,
            loadProof: () => null,
            saveProof: vi.fn(),
          },
          demoMode: false,
          invokeBootstrap: vi.fn(),
          invokeLocalProfilePreflight: vi.fn(),
          ...supportBundleDependencies,
          isDesktop: () => false,
          openWebSocket: vi.fn(),
        }),
      ).rejects.toBeInstanceOf(BrowserAuthenticationRequired);

      expect(window.location.href).not.toContain("token");
      expect(window.location.pathname).toBe("/routes");
      expect(fetchBootstrap).toHaveBeenCalledWith(
        _case === "replayed" ? "r".repeat(43) : null,
        _case === "replayed" ? "e".repeat(64) : null,
      );
      expect(clearProof).toHaveBeenCalledOnce();
    },
  );

  test("scrubs an unknown double-slash path without protocol-relative navigation", () => {
    window.history.replaceState(
      null,
      "",
      `${window.location.origin}//status#token=${"a".repeat(43)}`,
    );

    expect(() =>
      consumeBrowserLaunchTokenFromLocation(window.location, window.history),
    ).not.toThrow();
    expect(window.location.origin).not.toBe("http://status");
    expect(window.location.pathname).toBe("//status");
    expect(window.location.hash).toBe("");
  });
});
