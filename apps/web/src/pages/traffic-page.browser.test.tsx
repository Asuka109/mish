import { TooltipProvider } from "@mish/ui";
import type {
  TrafficCommandAuthorityDto,
  TrafficCommandOperation,
  TrafficCommandResultDto,
} from "@mish/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { FixtureTrafficClient } from "../data/fixture-traffic-client";
import { ProductProvider } from "../data/product-provider";
import { TrafficProvider } from "../data/traffic-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import "../styles.css";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

class BrowserCommandTrafficClient extends FixtureTrafficClient {
  iconRequests: string[] = [];
  receivedAuthority: TrafficCommandAuthorityDto | null = null;
  receivedIds: string[] = [];

  override async getProcessIcon(connectionId: string) {
    this.iconRequests.push(connectionId);
    return {
      dataUrl:
        connectionId === "fixture-connection-1"
          ? ("data:image/png;base64,iVBORw0KGgo=" as const)
          : null,
    };
  }

  supportsCommand(_command: TrafficCommandOperation) {
    return true;
  }

  async closeFilteredVisible(
    authority: TrafficCommandAuthorityDto,
    connectionIds: string[],
  ): Promise<TrafficCommandResultDto> {
    this.receivedAuthority = authority;
    this.receivedIds = connectionIds;
    const before = await this.getSnapshot();
    const targets = new Set(connectionIds);
    const snapshot = {
      ...before,
      activeConnections: before.activeConnections.filter(
        (connection) => !targets.has(connection.id),
      ),
      sequence: before.sequence + 1,
    };
    this.publishSnapshot(snapshot);
    return {
      failure: null,
      operation: "close-filtered-visible",
      remainingConnectionIds: [],
      snapshot,
      status: "success",
      targetCount: connectionIds.length,
    };
  }
}

beforeAll(() => loadAllLocales());

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

function renderTraffic(client: BrowserCommandTrafficClient) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <AppearanceProvider initialPreference="light">
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/traffic"]}>
          <ProductProvider client={new FixtureStatusClient()}>
            <TrafficProvider client={client}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </TrafficProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

async function overflowingTrafficClient() {
  const client = new BrowserCommandTrafficClient();
  const snapshot = await client.getSnapshot();
  const connection = snapshot.activeConnections[0]!;
  client.publishSnapshot({
    ...snapshot,
    activeConnections: [
      {
        ...connection,
        providerChain: Array.from({ length: 12 }, (_, index) => `Provider ${index + 1}`),
        routeChain: Array.from({ length: 48 }, (_, index) => `Route hop ${index + 1}`),
      },
    ],
    adapterKind: "rpc",
    sequence: snapshot.sequence + 1,
  });
  return client;
}

describe("Traffic filtered-visible close", () => {
  test.each([
    ["wide", 1_200, 800],
    ["narrow", 390, 700],
    ["short", 900, 420],
  ])(
    "keeps the detail shell bounded with body-only scrolling in a %s viewport",
    async (_name, width, height) => {
      await page.viewport(width, height);
      const client = await overflowingTrafficClient();
      renderTraffic(client);

      const row = page.getByRole("row", { name: /docs\.fixture\.invalid/ });
      await expect.element(row).toBeVisible();
      row.element().focus();
      await userEvent.keyboard("{Enter}");
      const dialog = page.getByRole("dialog", { name: "Connection details" });
      await expect.element(dialog).toBeVisible();

      const shell = dialog.element() as HTMLElement;
      const header = shell.querySelector<HTMLElement>(".dialog-header");
      const body = shell.querySelector<HTMLElement>(".traffic-detail-body");
      const footer = shell.querySelector<HTMLElement>(".dialog-footer");
      const workspace = document.querySelector<HTMLElement>(".workspace-page-scroll");
      if (!header || !body || !footer || !workspace)
        throw new Error("Missing detail dialog anatomy");

      const shellRect = shell.getBoundingClientRect();
      expect(shellRect.top).toBeGreaterThanOrEqual(23);
      expect(shellRect.bottom).toBeLessThanOrEqual(height - 23);
      expect(getComputedStyle(shell).overflow).toBe("hidden");
      expect(getComputedStyle(body).overflowY).toBe("auto");
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(body.getBoundingClientRect().top).toBeCloseTo(
        header.getBoundingClientRect().bottom,
        0,
      );
      expect(body.getBoundingClientRect().bottom).toBeCloseTo(
        footer.getBoundingClientRect().top,
        0,
      );

      const headerTop = header.getBoundingClientRect().top;
      const footerTop = footer.getBoundingClientRect().top;
      const workspaceScrollTop = workspace.scrollTop;
      const documentScrollTop = document.scrollingElement?.scrollTop ?? 0;
      body.scrollTop = body.scrollHeight;
      await expect.poll(() => body.scrollTop).toBeGreaterThan(0);

      expect(header.getBoundingClientRect().top).toBeCloseTo(headerTop, 1);
      expect(footer.getBoundingClientRect().top).toBeCloseTo(footerTop, 1);
      expect(workspace.scrollTop).toBe(workspaceScrollTop);
      expect(document.scrollingElement?.scrollTop ?? 0).toBe(documentScrollTop);
      expect(
        [...body.querySelectorAll<HTMLElement>("*")].filter((element) => {
          const style = getComputedStyle(element);
          return (
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight
          );
        }),
      ).toHaveLength(0);
    },
  );

  test("preserves detail selection, actions, Escape, and close focus restoration", async () => {
    await page.viewport(900, 420);
    const client = await overflowingTrafficClient();
    renderTraffic(client);

    const row = page.getByRole("row", { name: /docs\.fixture\.invalid/ });
    await expect.element(row).toBeVisible();
    row.element().focus();
    await userEvent.keyboard("{Enter}");
    const dialog = page.getByRole("dialog", { name: "Connection details" });
    await expect.element(dialog).toBeVisible();

    const destination = dialog.getByText("docs.fixture.invalid", { exact: true });
    expect(getComputedStyle(destination.element()).userSelect).toBe("text");
    await userEvent.tripleClick(destination);
    expect(document.getSelection()?.toString().trim()).toBe("docs.fixture.invalid");
    let copiedText: string | null = null;
    document.addEventListener(
      "copy",
      () => {
        copiedText = document.getSelection()?.toString().trim() ?? null;
      },
      { once: true },
    );
    await userEvent.copy();
    expect(copiedText).toBe("docs.fixture.invalid");

    const action = dialog.element().querySelector<HTMLButtonElement>(".dialog-footer button");
    if (!action) throw new Error("Missing connection close action");
    await userEvent.click(action);
    const confirmation = page.getByRole("alertdialog", {
      name: "Close this active connection?",
    });
    await expect.element(confirmation).toBeVisible();
    await userEvent.click(confirmation.getByRole("button", { name: "Cancel" }));
    await expect.element(confirmation).not.toBeInTheDocument();
    expect(document.activeElement).toBe(action);

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row.element());
  });

  test("shares canonical protocol presentation across the row, accessibility tree, detail, and copy", async () => {
    await page.viewport(1_200, 700);
    const client = new BrowserCommandTrafficClient();
    renderTraffic(client);

    const row = page.getByRole("row", { name: /docs\.fixture\.invalid.*TCP · HTTPS/ });
    await expect.element(row).toBeVisible();
    await expect.element(row.getByText("TCP · HTTPS")).toBeVisible();

    await userEvent.click(row);
    const dialog = page.getByRole("dialog", { name: "Connection details" });
    await expect.element(dialog).toHaveTextContent("TCP · HTTPS");

    const protocol = dialog.getByText("TCP · HTTPS", { exact: true });
    await userEvent.tripleClick(protocol);
    let copiedText: string | null = null;
    document.addEventListener(
      "copy",
      () => {
        copiedText = document.getSelection()?.toString().trim() ?? null;
      },
      { once: true },
    );
    await userEvent.copy();
    expect(copiedText).toBe("TCP · HTTPS");
  });

  test("renders the normalized provider chain without orphaned separators", async () => {
    await page.viewport(1_200, 700);
    const client = new BrowserCommandTrafficClient();
    const snapshot = await client.getSnapshot();
    const connection = snapshot.activeConnections[0]!;
    client.publishSnapshot({
      ...snapshot,
      activeConnections: [{ ...connection, providerChain: [] }],
      sequence: snapshot.sequence + 1,
    });
    renderTraffic(client);

    await userEvent.click(page.getByRole("row", { name: /docs\.fixture\.invalid/ }));
    const dialog = page.getByRole("dialog", { name: "Connection details" });
    await expect.element(dialog).toHaveTextContent("Provider chain");
    await expect.element(dialog).toHaveTextContent("Unavailable");
    await expect.element(dialog).not.toHaveTextContent("→");

    await userEvent.keyboard("{Escape}");
    client.publishSnapshot({
      ...snapshot,
      activeConnections: [
        { ...connection, providerChain: ["Provider A", "东京 🚀", "Provider A"] },
      ],
      sequence: snapshot.sequence + 2,
    });
    await userEvent.click(page.getByRole("row", { name: /docs\.fixture\.invalid/ }));
    await expect
      .element(page.getByRole("dialog", { name: "Connection details" }))
      .toHaveTextContent("Provider A → 东京 🚀 → Provider A");
  });

  test("opens details from the whole row without clipping or hijacking Close", async () => {
    await page.viewport(1_200, 700);
    const client = new BrowserCommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderTraffic(client);

    const row = page.getByRole("row", { name: /docs\.fixture\.invalid/ });
    const close = row.getByRole("button", { name: "Close" });
    await expect.element(row).toBeVisible();
    const closeCell = close.element().closest("td");
    if (!closeCell) throw new Error("Missing close action cell");
    expect(closeCell.scrollWidth).toBeLessThanOrEqual(closeCell.clientWidth);

    await userEvent.click(row);
    await expect.element(page.getByRole("dialog", { name: "Connection details" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    row.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Connection details" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(close);
    await expect
      .element(page.getByRole("alertdialog", { name: "Close this active connection?" }))
      .toBeVisible();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("freezes the confirmed ID set while live snapshots continue", async () => {
    await page.viewport(900, 700);
    const client = new BrowserCommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderTraffic(client);

    const search = page.getByRole("textbox", { name: "Search Traffic" });
    await expect.element(search).toBeVisible();
    await expect
      .poll(() => container?.querySelector('img[src^="data:image/png;base64,"]') !== null)
      .toBe(true);
    expect(client.iconRequests.filter((id) => id === "fixture-connection-1")).toHaveLength(1);
    await userEvent.hover(page.getByText("Fixture Browser"));
    await expect
      .element(page.getByText("/synthetic/apps/fixture-browser", { exact: true }))
      .toBeVisible();
    await userEvent.fill(search, "process:browser");
    await userEvent.click(page.getByRole("button", { name: "Close Visible Connections" }));
    await expect
      .element(page.getByRole("alertdialog", { name: "Close the filtered visible connections?" }))
      .toHaveTextContent("Target count: 1");

    client.publishSnapshot({
      ...initial,
      activeConnections: [
        ...initial.activeConnections,
        {
          ...initial.activeConnections[0]!,
          destinationHost: "newer.fixture.invalid",
          id: "newer-matching-connection",
        },
      ],
      adapterKind: "rpc",
      sequence: initial.sequence + 1,
    });
    await expect
      .element(page.getByRole("alertdialog", { name: "Close the filtered visible connections?" }))
      .toHaveTextContent("Target count: 1");

    await userEvent.click(
      page
        .getByRole("alertdialog", { name: "Close the filtered visible connections?" })
        .getByRole("button", { name: "Close Visible Connections" }),
    );
    await expect.element(page.getByText("newer.fixture.invalid")).toBeVisible();
    expect(client.receivedAuthority?.sequence).toBe(initial.sequence);
    expect(client.receivedIds).toEqual([initial.activeConnections[0]!.id]);
  });

  test("pauses one complete view, keeps keyboard details stable, and resumes without a layout jump", async () => {
    await page.viewport(390, 700);
    const client = new BrowserCommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderTraffic(client);

    const pause = page.getByRole("button", { name: "Pause View" });
    await expect.element(pause).toBeVisible();
    const beforeHeight = document.documentElement.scrollHeight;
    await userEvent.click(pause);
    await expect.element(page.getByRole("button", { name: "Resume View" })).toBeVisible();

    client.publishSnapshot({
      ...initial,
      activeConnections: [
        ...initial.activeConnections,
        {
          ...initial.activeConnections[0]!,
          destinationHost: "paused-newer.fixture.invalid",
          id: "paused-newer-connection",
        },
      ],
      adapterKind: "rpc",
      sequence: initial.sequence + 1,
    });

    await expect.element(page.getByText(/1 newer updates are ready/)).toBeVisible();
    await expect.element(page.getByText("paused-newer.fixture.invalid")).not.toBeInTheDocument();
    const row = page.getByRole("row", { name: /docs\.fixture\.invalid/ });
    row.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Connection details" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    expect(document.documentElement.scrollHeight).toBeGreaterThanOrEqual(beforeHeight);
    await userEvent.click(page.getByRole("button", { name: "Resume View" }));
    await expect.element(page.getByText("paused-newer.fixture.invalid")).toBeVisible();
  });

  test("expires a paused view on Traffic session replacement", async () => {
    const client = new BrowserCommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderTraffic(client);

    await userEvent.click(page.getByRole("button", { name: "Pause View" }));
    client.publishSnapshot({
      ...initial,
      activeConnections: [
        {
          ...initial.activeConnections[0]!,
          destinationHost: "replacement.fixture.invalid",
          id: "replacement-connection",
        },
      ],
      adapterKind: "rpc",
      profileId: "replacement-profile",
      reconnectCount: 1,
      sequence: 1,
      sessionId: "replacement-session",
    });

    await expect.element(page.getByRole("button", { name: "Pause View" })).toBeVisible();
    await expect.element(page.getByText("replacement.fixture.invalid")).toBeVisible();
    await expect.element(page.getByText("docs.fixture.invalid")).not.toBeInTheDocument();
  });
});
