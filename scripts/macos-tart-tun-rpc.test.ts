import assert from "node:assert/strict";
import test from "node:test";

import { summarizeStatus } from "./macos-tart-tun-rpc.ts";

function snapshot(
  phase: string,
  components: { core: string; dns: string; interface: string; routes: string },
) {
  return {
    runtime: {
      captureOperation: { phase: phase === "applied" ? "applied" : "pending" },
      core: { phase: "running" },
      systemProxyEnabled: false,
      tun: {
        desired: true,
        failure: null,
        observation: components,
        phase,
      },
      tunEnabled: phase === "applied",
    },
  };
}

test("reports Applied only after pending and all privileged observations are confirmed", () => {
  const confirmed = {
    core: "confirmed",
    dns: "confirmed",
    interface: "confirmed",
    routes: "confirmed",
  };
  assert.equal(
    summarizeStatus(snapshot("applied", confirmed), ["off", "pending"]).appliedOnlyAfterConfirmed,
    true,
  );
  assert.equal(
    summarizeStatus(snapshot("applied", confirmed), ["off"]).appliedOnlyAfterConfirmed,
    false,
  );
  assert.equal(
    summarizeStatus(snapshot("applied", { ...confirmed, routes: "partial" }), [
      "pending",
      "applied",
    ]).appliedOnlyAfterConfirmed,
    false,
  );
});

test("distinguishes confirmed disabled cleanup from residual network effects", () => {
  const disabled = summarizeStatus(
    snapshot("off", { core: "absent", dns: "absent", interface: "absent", routes: "absent" }),
  );
  const residual = summarizeStatus(
    snapshot("off", {
      core: "absent",
      dns: "absent",
      interface: "confirmed",
      routes: "partial",
    }),
  );

  assert.equal(disabled.observedDisabled, true);
  assert.equal(residual.observedDisabled, false);
});
