import { act, render, waitFor } from "@testing-library/react";
import type {
  EventsSnapshotDto,
  SupportBundleClient,
  SupportBundlePreviewDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { EventsProvider, useEvents } from "./events-provider";
import { FixtureEventsClient } from "./fixture-events-client";

let events: ReturnType<typeof useEvents> | null = null;

function Probe() {
  events = useEvents();
  return null;
}

function currentEvents(): ReturnType<typeof useEvents> {
  if (!events) throw new Error("EventsProvider probe is not ready");
  return events;
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
      formatVersion: 3,
      maxBytes: 1024,
      previewId,
      timeRange: { endedAt: 2, startedAt: 1 },
    });
  }

  requestCount() {
    return this.requests.length;
  }
}

describe("EventsProvider command feedback", () => {
  it("keeps replacement support work isolated from retired completions", async () => {
    const client = new ReplacementEventsClient();
    const support = new DelayedSupportBundleClient();
    await client.initialize();
    events = null;
    render(
      <EventsProvider client={client} supportBundleClient={support}>
        <Probe />
      </EventsProvider>,
    );
    await waitFor(() => expect(events?.snapshot).not.toBeNull());

    act(() => {
      void events?.previewSupportBundle();
      void events?.previewSupportBundle();
    });
    expect(support.requestCount()).toBe(1);
    expect(currentEvents().supportBundlePending).toBe(true);

    act(() => client.publishReplacement());
    await waitFor(() => expect(events?.supportBundlePending).toBe(false));
    act(() => {
      void events?.previewSupportBundle();
    });
    expect(support.requestCount()).toBe(2);

    await act(async () => support.resolve(0, "retired-preview"));
    expect(currentEvents().supportBundlePending).toBe(true);
    expect(currentEvents().supportBundlePreview).toBeNull();

    await act(async () => support.resolve(1, "replacement-preview"));
    await waitFor(() => expect(events?.supportBundlePending).toBe(false));
    expect(currentEvents().supportBundlePreview?.previewId).toBe("replacement-preview");
  });
});
