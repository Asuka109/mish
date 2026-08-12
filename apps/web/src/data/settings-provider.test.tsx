import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  SettingsSnapshotDelivery,
  SettingsSnapshotDto,
  TunHelperLifecycleOptions,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { createFixtureSettingsSnapshot, FixtureSettingsClient } from "./fixture-settings-client";
import { SettingsProvider, useSettings } from "./settings-provider";

class ControlledSettingsClient extends FixtureSettingsClient {
  private readonly listeners = new Set<
    (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void
  >();

  override subscribeSnapshots(
    listener: (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      return undefined;
    };
  }

  publish(snapshot: SettingsSnapshotDto, delivery: SettingsSnapshotDelivery = "update") {
    for (const listener of this.listeners) listener(structuredClone(snapshot), delivery);
  }
}

function snapshot(
  authorityId: string,
  order: number,
  revision: number,
  phase: "failed" | "ready" | "stale" | "unknown",
) {
  const value = createFixtureSettingsSnapshot();
  return {
    ...value,
    adapterKind: "rpc" as const,
    applicationOrder: { authorityId, epoch: 1, order },
    capabilities: { ...value.capabilities, networkDns: "supported" as const },
    networkDns: { ...value.networkDns, phase },
    revision,
  };
}

function SettingsOrderHarness() {
  const { snapshot: current } = useSettings();
  return (
    <output data-testid="settings-order">
      {[
        current.applicationOrder.authorityId,
        current.applicationOrder.order,
        current.revision,
        current.networkDns.phase,
      ].join(":")}
    </output>
  );
}

function TunHelperHarness() {
  const { pending, repairTunHelper } = useSettings();
  return (
    <>
      <output data-testid="helper-pending">{String(pending)}</output>
      <button
        type="button"
        onClick={async () => {
          const result = await repairTunHelper();
          document.body.dataset.helperResult = String(result.ok);
        }}
      >
        Repair
      </button>
    </>
  );
}

class StaleTunHelperResultClient extends ControlledSettingsClient {
  override repairTunHelper = async (_options?: TunHelperLifecycleOptions) => {
    const value = snapshot("rust-a", 2, 7, "ready");
    value.tunHelperOperation = {
      admittedRevision: 1,
      failure: null,
      operation: "repair",
      operationId: "43500000-0000-4000-8000-000000000000",
      outcome: "applied",
      phase: "terminal",
    };
    return value;
  };
}

describe("SettingsProvider snapshot convergence", () => {
  it("accepts equal-preference observations and a lower-revision replacement baseline only", () => {
    const client = new ControlledSettingsClient();
    const initial = snapshot("rust-a", 1, 7, "unknown");
    render(
      <SettingsProvider client={client} initialSnapshot={initial}>
        <SettingsOrderHarness />
      </SettingsProvider>,
    );
    expect(screen.getByTestId("settings-order")).toHaveTextContent("rust-a:1:7:unknown");

    act(() => client.publish(snapshot("rust-a", 2, 7, "ready")));
    expect(screen.getByTestId("settings-order")).toHaveTextContent("rust-a:2:7:ready");

    act(() => client.publish(snapshot("rust-b", 1, 1, "stale"), "baseline"));
    expect(screen.getByTestId("settings-order")).toHaveTextContent("rust-b:1:1:stale");

    act(() => client.publish(snapshot("rust-a", 99, 99, "failed")));
    expect(screen.getByTestId("settings-order")).toHaveTextContent("rust-b:1:1:stale");
  });

  it("keeps authoritative pending state across remount", () => {
    const client = new ControlledSettingsClient();
    const initial = snapshot("rust-a", 1, 7, "unknown");
    initial.tunHelperOperation = {
      admittedRevision: 4,
      failure: null,
      operation: "repair",
      operationId: "43500000-0000-4000-8000-000000000004",
      outcome: null,
      phase: "finalizing",
    };
    render(
      <SettingsProvider client={client} initialSnapshot={initial}>
        <TunHelperHarness />
      </SettingsProvider>,
    );
    expect(screen.getByTestId("helper-pending")).toHaveTextContent("true");
  });

  it("does not settle a repair from a stale terminal operation", async () => {
    delete document.body.dataset.helperResult;
    const client = new StaleTunHelperResultClient();
    render(
      <SettingsProvider client={client} initialSnapshot={snapshot("rust-a", 1, 7, "unknown")}>
        <TunHelperHarness />
      </SettingsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    await waitFor(() => expect(document.body.dataset.helperResult).toBe("false"));
    expect(screen.getByTestId("helper-pending")).toHaveTextContent("false");
  });
});
