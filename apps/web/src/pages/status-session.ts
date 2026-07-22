import { useRef } from "react";
import type { TrafficSnapshotDto } from "@mish/contracts";

export interface StatusSessionTraffic extends TrafficSnapshotDto {}

interface SessionState {
  active: boolean;
  baseline: Pick<TrafficSnapshotDto, "downloadedBytes" | "uploadedBytes"> | null;
  previousDownloadSeries: number[];
  previousUploadSeries: number[];
  traffic: StatusSessionTraffic;
}

export const emptyStatusSessionTraffic: StatusSessionTraffic = {
  downloadBytesPerSecond: 0,
  downloadSeries: [],
  downloadedBytes: 0,
  uploadBytesPerSecond: 0,
  uploadSeries: [],
  uploadedBytes: 0,
};

function appendedSamples(previous: number[], next: number[]) {
  const overlap = Math.min(previous.length, next.length);
  for (let length = overlap; length > 0; length -= 1) {
    if (previous.slice(-length).every((value, index) => value === next[index])) {
      return next.slice(length);
    }
  }
  return next;
}

export function reconcileStatusSessionTraffic(
  state: SessionState,
  source: TrafficSnapshotDto,
  active: boolean,
): SessionState {
  if (!active) {
    return {
      active: false,
      baseline: null,
      previousDownloadSeries: [],
      previousUploadSeries: [],
      traffic: emptyStatusSessionTraffic,
    };
  }
  if (!state.active || !state.baseline) {
    return {
      active: true,
      baseline: { downloadedBytes: source.downloadedBytes, uploadedBytes: source.uploadedBytes },
      previousDownloadSeries: source.downloadSeries,
      previousUploadSeries: source.uploadSeries,
      traffic: emptyStatusSessionTraffic,
    };
  }
  const downloadAdded = appendedSamples(state.previousDownloadSeries, source.downloadSeries);
  const uploadAdded = appendedSamples(state.previousUploadSeries, source.uploadSeries);
  return {
    active: true,
    baseline: state.baseline,
    previousDownloadSeries: source.downloadSeries,
    previousUploadSeries: source.uploadSeries,
    traffic: {
      downloadBytesPerSecond: source.downloadBytesPerSecond,
      downloadSeries: [...state.traffic.downloadSeries, ...downloadAdded].slice(-512),
      downloadedBytes: Math.max(0, source.downloadedBytes - state.baseline.downloadedBytes),
      uploadBytesPerSecond: source.uploadBytesPerSecond,
      uploadSeries: [...state.traffic.uploadSeries, ...uploadAdded].slice(-512),
      uploadedBytes: Math.max(0, source.uploadedBytes - state.baseline.uploadedBytes),
    },
  };
}

export function useStatusSessionTraffic(source: TrafficSnapshotDto, active: boolean) {
  const state = useRef<SessionState>({
    active: false,
    baseline: null,
    previousDownloadSeries: [],
    previousUploadSeries: [],
    traffic: emptyStatusSessionTraffic,
  });
  state.current = reconcileStatusSessionTraffic(state.current, source, active);
  return state.current.traffic;
}
