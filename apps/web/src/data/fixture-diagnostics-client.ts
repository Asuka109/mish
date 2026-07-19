import type { DiagnosticHistoryDto, DiagnosticRunDto, DiagnosticsClient } from "@mish/contracts";

const fixtureRun: DiagnosticRunDto = {
  adapterKind: "fixture",
  checks: [
    {
      failure: null,
      finishedAt: Date.parse("2026-07-18T08:00:00.010Z"),
      id: "fixture-diagnostic:bridge",
      interpretation:
        "This fictional check represents a browser fixture only; no desktop bridge was contacted.",
      kind: "desktop-bridge",
      observedFact: { authenticated: false, kind: "bridge" },
      routeTarget: { kind: "local-bridge" },
      scope: "Fictional browser fixture",
      startedAt: Date.parse("2026-07-18T08:00:00.000Z"),
      status: "passed",
    },
    {
      failure: "dns-failed",
      finishedAt: Date.parse("2026-07-18T08:00:00.020Z"),
      id: "fixture-diagnostic:dns",
      interpretation:
        "This fictional DNS failure demonstrates presentation only and is not a device observation.",
      kind: "dns",
      observedFact: { kind: "failure", reason: "Synthetic fixture DNS failure" },
      routeTarget: { kind: "fixed-endpoint", route: "direct" },
      scope: "Synthetic fixture.invalid endpoint",
      startedAt: Date.parse("2026-07-18T08:00:00.011Z"),
      status: "failed",
    },
    {
      failure: "unavailable",
      finishedAt: Date.parse("2026-07-18T08:00:00.030Z"),
      id: "fixture-diagnostic:proxy",
      interpretation:
        "Browser fixtures cannot perform a scoped proxy check and do not fabricate desktop success.",
      kind: "proxy-reachability",
      observedFact: { kind: "unavailable", reason: "Browser fixture has no Controller" },
      routeTarget: { kind: "fixed-endpoint", route: "direct" },
      scope: "Fictional browser fixture",
      startedAt: Date.parse("2026-07-18T08:00:00.021Z"),
      status: "unavailable",
    },
  ],
  finishedAt: Date.parse("2026-07-18T08:00:00.030Z"),
  id: "fixture-diagnostic-run",
  policy: {
    endpointLabel: "Synthetic fixture.invalid 204 endpoint",
    expectedHttpStatus: 204,
    id: "mish-guided-diagnostics-fixture-v1",
    timeoutMilliseconds: 5_000,
  },
  profileId: "fixture-profile",
  startedAt: Date.parse("2026-07-18T08:00:00.000Z"),
  status: "completed",
};

export class FixtureDiagnosticsClient implements DiagnosticsClient {
  private runSequence = 0;
  private history: DiagnosticHistoryDto = {
    activeRunId: null,
    adapterKind: "fixture",
    runs: [],
  };

  async cancelRun() {
    return structuredClone(this.history);
  }

  dispose() {}

  async getHistory() {
    return structuredClone(this.history);
  }

  async startRun() {
    this.runSequence += 1;
    const run = structuredClone(fixtureRun);
    run.id = `fixture-diagnostic-run-${this.runSequence}`;
    run.checks = run.checks.map((check) => ({
      ...check,
      id: `${run.id}:${check.kind}`,
    }));
    this.history = {
      activeRunId: null,
      adapterKind: "fixture",
      runs: [run, ...this.history.runs].slice(0, 8),
    };
    return structuredClone(this.history);
  }
}

export function createFixtureDiagnosticsClient() {
  return new FixtureDiagnosticsClient();
}
