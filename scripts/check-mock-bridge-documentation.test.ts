import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkMockBridgeDocumentation,
  loadMockBridgeDocumentationSources,
} from "./check-mock-bridge-documentation.ts";

const sources = loadMockBridgeDocumentationSources();

describe("mock-bridge documentation policy", () => {
  it("accepts the checked catalog, CSP, icon policy, and documentation", () => {
    assert.doesNotThrow(() => checkMockBridgeDocumentation(sources));
  });

  it("rejects a documentation inventory that drifts from the mock catalog", () => {
    assert.throws(
      () =>
        checkMockBridgeDocumentation({
          ...sources,
          bridgeProtocol: sources.bridgeProtocol.replace("`traffic.getProcessIcon`", ""),
        }),
      /implemented methods must match/u,
    );
  });

  it("rejects remote script CSP drift", () => {
    assert.throws(
      () =>
        checkMockBridgeDocumentation({
          ...sources,
          desktopConfig: sources.desktopConfig.replace(
            "script-src 'self'",
            "script-src 'self' https:",
          ),
        }),
      /script-src/u,
    );
  });

  it("rejects a missing no-referrer documentation claim", () => {
    assert.throws(
      () =>
        checkMockBridgeDocumentation({
          ...sources,
          desktopBootstrap: sources.desktopBootstrap.replace(
            'The image request uses `referrerPolicy="no-referrer"`; ',
            "",
          ),
        }),
      /referrerPolicy/u,
    );
  });
});
