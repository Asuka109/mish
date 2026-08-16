import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../app";
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

function renderProduct() {
  const queryClient = createQueryClient({ queryRetry: 0, mutationRetry: 0 });
  const source = {
    invoke: async (operation: keyof typeof data) => ({
      correlationId: "fixture-correlation-0001",
      operation,
      parentEpoch: 1,
      revision: 1,
      sessionGeneration: 1,
      value: "accepted" as const,
      data: data[operation],
    }),
  };
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
    expect(await screen.findByText("fixture-profile")).toBeInTheDocument();
  });
});
