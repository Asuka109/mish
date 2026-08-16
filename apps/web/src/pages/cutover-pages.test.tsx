import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppRoutes, PRODUCT_ROUTE_PATHS } from "../app";
import { CutoverViewProvider } from "../data/cutover-view-facade";
import { createQueryClient, MishQueryProvider } from "@mish/ui-state";

const data = {
  "status.snapshot": {
    kind: "status" as const,
    phase: "ready" as const,
    profileName: "fixture-profile",
    activeConnections: 2,
    downloadBytesPerSecond: 120,
    uploadBytesPerSecond: 80,
  },
  "routes.snapshot": {
    kind: "routes" as const,
    groups: [{ id: "auto", label: "Auto", selected: "edge", children: ["edge", "direct"] }],
  },
  "profile.refresh": {
    kind: "profiles" as const,
    profiles: [
      {
        id: "fixture",
        name: "Fixture profile",
        source: "file" as const,
        active: true,
        updatedAt: "2026-08-16T00:00:00Z",
      },
    ],
  },
  "traffic.snapshot": {
    kind: "traffic" as const,
    connections: [
      {
        id: "connection-1",
        destination: "example.test",
        protocol: "HTTPS",
        downloadBytes: 12,
        uploadBytes: 4,
      },
    ],
    rules: [{ id: "rule-1", target: "example.test", action: "Proxy" }],
  },
  "events.snapshot": {
    kind: "events" as const,
    events: [
      {
        id: "event-1",
        level: "info" as const,
        source: "application" as const,
        message: "Session ready",
        observedAt: "2026-08-16T00:00:00Z",
      },
    ],
  },
  "settings.snapshot": {
    kind: "settings" as const,
    appearance: "system" as const,
    language: "en" as const,
    readOnly: true as const,
  },
};

function renderProduct(
  source = {
    invoke: async (operation: keyof typeof data) => ({
      correlationId: "fixture-correlation-0001",
      operation,
      parentEpoch: 1,
      revision: 1,
      sessionGeneration: 1,
      value: "accepted" as const,
      data: data[operation],
    }),
  },
) {
  window.history.replaceState({}, "", "/status");
  const queryClient = createQueryClient({ queryRetry: 0, mutationRetry: 0 });
  return render(
    <MishQueryProvider client={queryClient}>
      <CutoverViewProvider source={source}>
        <AppRoutes />
      </CutoverViewProvider>
    </MishQueryProvider>,
  );
}

describe("CUTOVER Web product pages", () => {
  it("keeps six primary pages navigable through the contract-first facade", async () => {
    renderProduct();
    expect(screen.getByRole("heading", { name: "Status" })).toBeInTheDocument();
    for (const label of ["Routes", "Profiles", "Traffic", "Events", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText("fixture-profile", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("renders the complete product surface instead of the admission probe", async () => {
    renderProduct();
    expect(PRODUCT_ROUTE_PATHS).toHaveLength(6);
    expect(PRODUCT_ROUTE_PATHS).toEqual([
      "/status",
      "/routes",
      "/profiles",
      "/traffic",
      "/events",
      "/settings",
    ]);
    const surface = () => document.querySelector("[data-product-surface='mish']");
    expect(surface()).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByText("remount")).not.toBeInTheDocument();
    expect(screen.queryByText("admission probe")).not.toBeInTheDocument();

    for (const label of ["Routes", "Profiles", "Traffic", "Events", "Settings"]) {
      fireEvent.click(screen.getByRole("link", { name: label }));
      expect(
        await screen.findByRole("heading", { name: label }, { timeout: 3000 }),
      ).toBeInTheDocument();
      expect(surface()).toHaveAttribute("data-product-surface", "mish");
    }
  });

  it("keeps empty and error projection states honest and actionable", async () => {
    renderProduct({
      invoke: async (operation) => ({
        correlationId: "fixture-correlation-0002",
        operation,
        parentEpoch: 1,
        revision: 1,
        sessionGeneration: 1,
        value: "accepted" as const,
      }),
    });
    expect(
      await screen.findByText(
        "No status projection has been published by the current session.",
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();

    screen.getByRole("link", { name: "Routes" }).click();
    expect(
      await screen.findByText(
        "No route graph projection has been published by the current session.",
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a failed Query projection with a retry affordance", async () => {
    renderProduct({
      invoke: async () => {
        throw new Error("projection offline");
      },
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText("projection offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
