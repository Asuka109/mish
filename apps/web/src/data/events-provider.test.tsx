import { act, render, waitFor } from "@testing-library/react";
import type {
  DiagnosticHistoryDto,
  DiagnosticsClient,
  EventsSnapshotDto,
  SupportBundleClient,
  SupportBundlePreviewDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { EventsProvider, useEvents } from "./events-provider";
import { FixtureDiagnosticsClient } from "./fixture-diagnostics-client";
import { FixtureEventsClient } from "./fixture-events-client";

let events: ReturnType<typeof useEvents> | null = null;

function Probe() {
  events = useEvents();
  return null;
}

class ReplacementEventsClient extends FixtureEventsClient {
  private readonly listeners = new Set<(snapshot: EventsSnapshotDto) => void>();
  private snapshotState!: EventsSnapshotDto;

  async initialize() {
    this.snapshotState = await super.getSnapshot();
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override subscribeSnapshots(listener: (snapshot: EventsSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishReplacement() {
    this.snapshotState = {
      ...structuredClone(this.snapshotState),
      applicationOrder: {
        ...this.snapshotState.applicationOrder,
        epoch: this.snapshotState.applicationOrder.epoch + 1,
        order: 1,
      },
      profileId: `replacement-${this.snapshotState.applicationOrder.epoch + 1}`,
      sequence: 1,
      sessionId: `replacement-session-${this.snapshotState.applicationOrder.epoch + 1}`,
    };
    for (const listener of this.listeners) listener(structuredClone(this.snapshotState));
  }
}

class DelayedDiagnosticsClient implements DiagnosticsClient {
  private readonly requests: Array<{
    reject(error: Error): void;
    resolve(history: DiagnosticHistoryDto): void;
  }> = [];

  async cancelRun(): Promise<DiagnosticHistoryDto> {
    return { activeRunId: null, adapterKind: "rpc", runs: [] };
  }

  dispose() {}

  async getHistory(): Promise<DiagnosticHistoryDto> {
    return { activeRunId: null, adapterKind: "rpc", runs: [] };
  }

  startRun(): Promise<DiagnosticHistoryDto> {
    return new Promise((resolve, reject) => {
      this.requests.push({ reject, resolve });
    });
  }

  reject(index: number) {
    this.requests[index]?.reject(new Error("Retired diagnostic request"));
  }

  resolve(index: number, history: DiagnosticHistoryDto) {
    this.requests[index]?.resolve(structuredClone(history));
  }

  requestCount() {
    return this.requests.length;
  }
}

class PollingDiagnosticsClient implements DiagnosticsClient {
  private readonly cancelRequests: Array<{
    resolve(history: DiagnosticHistoryDto): void;
  }> = [];
  private historyRequests = 0;

  constructor(private history: DiagnosticHistoryDto) {}

  cancelRun(): Promise<DiagnosticHistoryDto> {
    return new Promise((resolve) => {
      this.cancelRequests.push({ resolve });
    });
  }

  dispose() {}

  async getHistory(): Promise<DiagnosticHistoryDto> {
    this.historyRequests += 1;
    return structuredClone(this.history);
  }

  async startRun(): Promise<DiagnosticHistoryDto> {
    return structuredClone(this.history);
  }

  completeCancel(index: number) {
    this.history = { ...this.history, activeRunId: null };
    this.cancelRequests[index]?.resolve(structuredClone(this.history));
  }

  cancelRequestCount() {
    return this.cancelRequests.length;
  }

  historyRequestCount() {
    return this.historyRequests;
  }
}

class DelayedSupportBundleClient implements SupportBundleClient {
  readonly availability = "supported" as const;
  private readonly requests: Array<{
    resolve(preview: SupportBundlePreviewDto): void;
  }> = [];

  preview(): Promise<SupportBundlePreviewDto> {
    return new Promise((resolve) => {
      this.requests.push({ resolve });
    });
  }

  async save() {
    return { status: "written" as const };
  }

  resolve(index: number, previewId: string) {
    this.requests[index]?.resolve({
      categories: [],
      contentBytes: 0,
      excludedOrRedacted: [],
      fileType: "application/json",
      formatVersion: 1,
      maxBytes: 1024,
      previewId,
      timeRange: { endedAt: 2, startedAt: 1 },
    });
  }

  requestCount() {
    return this.requests.length;
  }
}

function renderProvider(
  client: ReplacementEventsClient,
  diagnosticsClient: DiagnosticsClient,
  supportBundleClient: SupportBundleClient,
) {
  events = null;
  return render(
    <EventsProvider
      client={client}
      diagnosticsClient={diagnosticsClient}
      supportBundleClient={supportBundleClient}
    >
      <Probe />
    </EventsProvider>,
  );
}

describe("EventsProvider command feedback", () => {
  it("keeps replacement diagnostics and support work isolated from retired completions", async () => {
    const client = new ReplacementEventsClient();
    const diagnostics = new DelayedDiagnosticsClient();
    const support = new DelayedSupportBundleClient();
    await client.initialize();
    renderProvider(client, diagnostics, support);
    await waitFor(() => expect(events?.snapshot).not.toBeNull());

    act(() => {
      void events?.startDiagnosticRun();
      void events?.startDiagnosticRun();
    });
    expect(diagnostics.requestCount()).toBe(1);
    expect(events?.diagnosticPending).toBe(true);

    act(() => client.publishReplacement());
    await waitFor(() => expect(events?.diagnosticPending).toBe(false));
    act(() => {
      void events?.startDiagnosticRun();
    });
    expect(diagnostics.requestCount()).toBe(2);
    expect(events?.diagnosticPending).toBe(true);

    await act(async () => diagnostics.reject(0));
    expect(events?.diagnosticPending).toBe(true);
    expect(events?.diagnosticError).toBeNull();

    const history = await new FixtureDiagnosticsClient().startRun();
    history.runs[0]!.id = "replacement-diagnostic";
    await act(async () => diagnostics.resolve(1, history));
    await waitFor(() => expect(events?.diagnosticPending).toBe(false));
    expect(events?.diagnosticHistory?.runs[0]?.id).toBe("replacement-diagnostic");

    act(() => {
      void events?.previewSupportBundle();
      void events?.previewSupportBundle();
    });
    expect(support.requestCount()).toBe(1);
    expect(events?.supportBundlePending).toBe(true);

    act(() => client.publishReplacement());
    await waitFor(() => expect(events?.supportBundlePending).toBe(false));
    act(() => {
      void events?.previewSupportBundle();
    });
    expect(support.requestCount()).toBe(2);
    expect(events?.supportBundlePending).toBe(true);

    await act(async () => support.resolve(0, "retired-preview"));
    expect(events?.supportBundlePending).toBe(true);
    expect(events?.supportBundlePreview).toBeNull();

    await act(async () => support.resolve(1, "replacement-preview"));
    await waitFor(() => expect(events?.supportBundlePending).toBe(false));
    expect(events?.supportBundlePreview?.previewId).toBe("replacement-preview");
  });

  it("terminates diagnostic feedback when polling advances the read token", async () => {
    const client = new ReplacementEventsClient();
    const initialHistory = await new FixtureDiagnosticsClient().startRun();
    initialHistory.activeRunId = initialHistory.runs[0]!.id;
    const diagnostics = new PollingDiagnosticsClient(initialHistory);
    await client.initialize();
    renderProvider(client, diagnostics, new DelayedSupportBundleClient());
    await waitFor(() => expect(events?.diagnosticHistory?.activeRunId).toBeTruthy());

    const historyRequestsBeforeCancel = diagnostics.historyRequestCount();
    act(() => {
      void events?.cancelDiagnosticRun(initialHistory.activeRunId!);
    });
    expect(diagnostics.cancelRequestCount()).toBe(1);
    expect(events?.diagnosticPending).toBe(true);
    await waitFor(() =>
      expect(diagnostics.historyRequestCount()).toBeGreaterThan(historyRequestsBeforeCancel),
    );

    await act(async () => diagnostics.completeCancel(0));
    await waitFor(() => expect(events?.diagnosticPending).toBe(false));

    act(() => {
      void events?.cancelDiagnosticRun(initialHistory.activeRunId!);
    });
    expect(diagnostics.cancelRequestCount()).toBe(2);
    await act(async () => diagnostics.completeCancel(1));
  });
});
