import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MockBridgeDocumentationSources {
  bridgeProtocol: string;
  catalog: string;
  desktopBootstrap: string;
  desktopConfig: string;
  iconContract: string;
  iconRenderer: string;
  serviceProbePolicy: string;
}

const implementedSectionStart = "### Mock behavior inventory";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function required(source: string, value: string, label: string) {
  invariant(
    source.replace(/\s+/gu, " ").includes(value.replace(/\s+/gu, " ")),
    `${label} must include ${JSON.stringify(value)}.`,
  );
}

function mockInventorySection(source: string) {
  const start = source.indexOf(implementedSectionStart);
  invariant(start >= 0, "Bridge protocol documentation must contain the mock behavior inventory.");
  const nextHeading = source.indexOf("\n## ", start + implementedSectionStart.length);
  return source.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

export function loadMockBridgeDocumentationSources(
  repositoryRoot = resolve(import.meta.dirname, ".."),
): MockBridgeDocumentationSources {
  const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");
  return {
    bridgeProtocol: read("docs/architecture/bridge-protocol-contract.md"),
    catalog: read("packages/bridge-protocol/bridge-protocol.json"),
    desktopBootstrap: read("docs/architecture/desktop-bootstrap.md"),
    desktopConfig: read("apps/desktop/src-tauri/tauri.conf.json"),
    iconContract: read("packages/contracts/src/index.ts"),
    iconRenderer: read("apps/web/src/components/service-monitor-section.tsx"),
    serviceProbePolicy: read("crates/desktop-bridge/src/service_probes.rs"),
  };
}

export function checkMockBridgeDocumentation(sources: MockBridgeDocumentationSources) {
  const catalog = JSON.parse(sources.catalog) as {
    mockImplementedMethods: string[];
    publicMethods: string[];
  };
  const publicMethods = new Set(catalog.publicMethods);
  const implementedMethods = new Set(catalog.mockImplementedMethods);
  invariant(
    publicMethods.size === catalog.publicMethods.length,
    "Public RPC catalog must be unique.",
  );
  invariant(
    [...implementedMethods].every((method) => publicMethods.has(method)),
    "Mock implemented RPC methods must be part of the public catalog.",
  );

  const inventory = mockInventorySection(sources.bridgeProtocol);
  required(
    inventory,
    "Catalog parity is a method-presence check, not behavioral parity.",
    "Mock inventory",
  );
  required(inventory, "Every other generated public method", "Mock inventory");
  required(inventory, "-32020", "Mock inventory");
  required(inventory, "This is intentionally not a universal mock", "Mock inventory");

  const documentedMethods = new Set(
    catalog.publicMethods.filter((method) => inventory.includes(`\`${method}\``)),
  );
  invariant(
    documentedMethods.size === implementedMethods.size &&
      [...documentedMethods].every((method) => implementedMethods.has(method)),
    "Mock inventory implemented methods must match bridge-protocol.json exactly.",
  );
  invariant(
    publicMethods.size > documentedMethods.size,
    "Mock inventory must retain an explicit unsupported public-method remainder.",
  );

  const config = JSON.parse(sources.desktopConfig) as {
    app?: { security?: { csp?: string } };
  };
  const csp = config.app?.security?.csp;
  invariant(typeof csp === "string", "Desktop configuration must define a CSP string.");
  const directives = new Map(
    csp.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/u);
      return [name, values];
    }),
  );
  const values = (directive: string) => directives.get(directive) ?? [];
  invariant(
    ["'self'", "data:", "https:"].every((value) => values("img-src").includes(value)),
    "Desktop CSP img-src must retain only self, data, and HTTPS images.",
  );
  for (const [directive, expected] of [
    ["script-src", ["'self'"]],
    ["font-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["form-action", ["'none'"]],
  ] as const) {
    invariant(
      JSON.stringify(values(directive)) === JSON.stringify(expected),
      `Desktop CSP ${directive} must remain ${expected.join(" ")}.`,
    );
  }
  invariant(
    !values("connect-src").some((value) => value === "https:" || value === "wss:"),
    "Desktop CSP must not allow remote frontend connections.",
  );

  for (const value of [
    "The sole remote-resource exception is a user-configured service-monitor",
    "It blocks inline or remote script execution, frames, objects, forms, remote fonts, remote frontend",
    "with both username and password omitted",
    'The image request uses `referrerPolicy="no-referrer"`',
    "no Mish RPC token, bootstrap token, profile credential, or URL userinfo",
    "This is not a generic URL loader",
    "can observe a direct image request",
  ]) {
    required(sources.desktopBootstrap, value, "Desktop bootstrap threat model");
  }
  for (const value of ['url.protocol === "https:"', 'url.username === ""', 'url.password === ""']) {
    required(sources.iconContract, value, "Service icon contract");
  }
  required(sources.iconRenderer, 'referrerPolicy="no-referrer"', "Service icon renderer");
  for (const value of [
    'url.scheme() == "https"',
    "url.username().is_empty()",
    "url.password().is_none()",
  ]) {
    required(sources.serviceProbePolicy, value, "Service icon persistence policy");
  }
}

if (import.meta.main) {
  checkMockBridgeDocumentation(loadMockBridgeDocumentationSources());
  console.log("Mock-bridge documentation policy is aligned with the RPC catalog and desktop CSP.");
}
