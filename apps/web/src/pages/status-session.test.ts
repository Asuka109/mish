import { describe, expect, it } from "vitest";
import { reconcileStatusSessionTraffic } from "./status-session";

const source = {
  downloadBytesPerSecond: 4,
  downloadSeries: [1, 2],
  downloadedBytes: 100,
  uploadBytesPerSecond: 2,
  uploadSeries: [3, 4],
  uploadedBytes: 40,
};

describe("Status session traffic", () => {
  it("drops inactive telemetry and starts a later capture session from a fresh baseline", () => {
    let state = reconcileStatusSessionTraffic(
      {
        active: false,
        baseline: null,
        previousDownloadSeries: [],
        previousUploadSeries: [],
        traffic: { ...source },
      },
      source,
      true,
    );
    expect(state.traffic.downloadSeries).toEqual([]);
    expect(state.traffic.downloadedBytes).toBe(0);

    state = reconcileStatusSessionTraffic(state, { ...source, downloadSeries: [1, 2, 5] }, true);
    expect(state.traffic.downloadSeries).toEqual([5]);

    state = reconcileStatusSessionTraffic(state, source, false);
    expect(state.traffic).toMatchObject({
      downloadBytesPerSecond: 0,
      downloadSeries: [],
      downloadedBytes: 0,
      uploadBytesPerSecond: 0,
      uploadSeries: [],
      uploadedBytes: 0,
    });

    state = reconcileStatusSessionTraffic(state, { ...source, downloadedBytes: 500 }, true);
    expect(state.traffic.downloadSeries).toEqual([]);
    expect(state.traffic.downloadedBytes).toBe(0);
  });

  it("retains at most 60 post-boundary samples", () => {
    let state = reconcileStatusSessionTraffic(
      {
        active: false,
        baseline: null,
        previousDownloadSeries: [],
        previousUploadSeries: [],
        traffic: { ...source },
      },
      source,
      true,
    );
    for (let value = 3; value <= 64; value += 1) {
      state = reconcileStatusSessionTraffic(
        state,
        {
          ...source,
          downloadSeries: [1, 2, value],
          uploadSeries: [3, 4, value],
        },
        true,
      );
    }
    expect(state.traffic.downloadSeries).toHaveLength(60);
    expect(state.traffic.uploadSeries).toHaveLength(60);
  });
});
