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
  receivedAuthority: TrafficCommandAuthorityDto | null = null;
  receivedIds: string[] = [];

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

describe("Traffic filtered-visible close", () => {
  test("freezes the confirmed ID set while live snapshots continue", async () => {
    await page.viewport(900, 700);
    const client = new BrowserCommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderTraffic(client);

    const search = page.getByRole("textbox", { name: "Search Traffic" });
    await expect.element(search).toBeVisible();
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
});
