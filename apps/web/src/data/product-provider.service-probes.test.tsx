import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusClientError, type StatusSnapshotDto } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { FixtureStatusClient } from "./fixture-status-client";
import { ProductProvider, useProduct } from "./product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

class SubscriptionWinsRaceClient extends FixtureStatusClient {
  private readonly listeners = new Set<(snapshot: StatusSnapshotDto) => void>();
  private rejectProbe: ((error: Error) => void) | null = null;

  override subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override testServiceMonitor(): Promise<StatusSnapshotDto> {
    return new Promise((_, reject) => {
      this.rejectProbe = reject;
    });
  }

  async publishConfirmedResult(monitorId: string) {
    const snapshot = await super.getSnapshot();
    const result = snapshot.probeResults.find((candidate) => candidate.monitorId === monitorId);
    if (!result) throw new Error(`Missing result for ${monitorId}`);
    result.latencyMilliseconds = 42;
    result.observedAt = "2026-07-21T12:00:00Z";
    result.status = "healthy";
    for (const listener of this.listeners) listener(snapshot);
  }

  rejectPendingProbe() {
    this.rejectProbe?.(new StatusClientError("remote", "Probe request failed"));
  }
}

function ProbeHarness() {
  const { hasServiceProbeFailed, isServiceProbePending, snapshot, testServiceMonitor } =
    useProduct();
  const monitorId = "google";
  const result = snapshot?.probeResults.find((candidate) => candidate.monitorId === monitorId);
  return (
    <>
      <button onClick={() => void testServiceMonitor(monitorId)} type="button">
        Test probe
      </button>
      <output data-testid="failure">{String(hasServiceProbeFailed(monitorId))}</output>
      <output data-testid="pending">{String(isServiceProbePending(monitorId))}</output>
      <output data-testid="latency">{result?.latencyMilliseconds ?? "none"}</output>
    </>
  );
}

describe("ProductProvider service probe command state", () => {
  it("keeps a newer subscribed probe result authoritative when the pending request fails", async () => {
    const client = new SubscriptionWinsRaceClient();
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={client}>
          <ProbeHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await screen.findByTestId("latency");
    fireEvent.click(screen.getByRole("button", { name: "Test probe" }));
    await waitFor(() => expect(screen.getByTestId("pending")).toHaveTextContent("true"));

    await act(async () => client.publishConfirmedResult("google"));
    await waitFor(() => expect(screen.getByTestId("latency")).toHaveTextContent("42"));

    await act(async () => client.rejectPendingProbe());
    await waitFor(() => {
      expect(screen.getByTestId("failure")).toHaveTextContent("false");
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
    });
  });
});
