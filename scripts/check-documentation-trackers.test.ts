import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  checkDocumentationTrackers,
  type DocumentationTrackerRegistry,
  validateDocumentationTrackers,
} from "./check-documentation-trackers.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function repositoryFixture(): {
  registry: DocumentationTrackerRegistry;
  sources: Record<string, string>;
} {
  const registry = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "docs/architecture/documentation-tracker-registry.json"),
      "utf8",
    ),
  ) as DocumentationTrackerRegistry;
  const sources = Object.fromEntries(
    registry.canonicalPaths.map((path) => [
      path,
      readFileSync(resolve(repositoryRoot, path), "utf8"),
    ]),
  );
  return { registry, sources };
}

test("repository canonical tracker references match the offline read-back", () => {
  assert.doesNotThrow(checkDocumentationTrackers);
});

test("closed Issue classified as active future work fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  const issue = fixture.issues.find((candidate) => candidate.number === 288);
  assert.ok(issue);
  issue.references[0].role = "active-dependency";
  assert.match(validateDocumentationTrackers(fixture, sources).join("\n"), /closed Issue #288/u);
});

test("unknown tracker roles fail instead of relying on a TypeScript cast", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues[0].references[0].role = "completed-deliveryy" as "completed-delivery";
  assert.match(validateDocumentationTrackers(fixture, sources).join("\n"), /unknown tracker role/u);
});

test("future-tense residue for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nFuture work such as Issue #288 must consume this convention.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("multiline future-tense residue for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nFuture work requires the follow-up tracked in\nIssue #288.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("ordinary future wording for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nIssue #288 will implement this lifecycle in a later change.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("passive future wording for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nIssue #288 will be implemented in a later change.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("need-based future wording for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/candidate-home-isolation.md"] +=
    "\nIssue #185 still needs implementation and remains unimplemented.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #185 is still described as future work/u,
  );
});

test("pending and outstanding wording for a closed Issue fails deterministically", () => {
  const { registry, sources } = repositoryFixture();
  for (const claim of [
    "Issue #185 is pending implementation.",
    "Issue #185 remains to be implemented.",
    "Issue #185 has not yet been delivered.",
    "Issue #185 implementation remains outstanding.",
  ]) {
    const fixtureSources = { ...sources };
    fixtureSources["docs/architecture/candidate-home-isolation.md"] += `\n${claim}\n`;
    assert.match(
      validateDocumentationTrackers(registry, fixtureSources).join("\n"),
      /closed Issue #185 is still described as future work/u,
      claim,
    );
  }
});

test("URL-only Issue occurrences receive independent context validation", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nFuture work: https://github.com/Asuka109/mish/issues/288 will be implemented later.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("Issue URLs must belong to the registered repository", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nHistorical context: https://github.com/example/other/issues/288 was closed.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /external Issue URL in docs\/architecture\/state-machine-kernel\.md: example\/other#288/u,
  );
});

test("same-repository Issue URLs are case-insensitive", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] = fixtureSources[
    "docs/architecture/state-machine-kernel.md"
  ].replace("Issue #288", "[Issue #288](https://github.com/asuka109/MISH/issues/288)");
  assert.deepEqual(validateDocumentationTrackers(registry, fixtureSources), []);
});

test("each superseded occurrence needs its own decision context", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/README.md"] += "\nIssue #343 is the active implementation plan.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /docs\/README.md:#343 lacks explicit superseded or rejected context/u,
  );
});

test("nearby tracker occurrences cannot share decision context", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/README.md"] +=
    "\nIssue #343 was rejected. Issue #343 is now the active implementation plan.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /docs\/README.md:#343 lacks explicit superseded or rejected context/u,
  );
});

test("adjacent sentences cannot hide future residue for a closed Issue", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nCompleted Issue #288. It remains to be implemented later.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("future wording for another Issue is not attributed to a closed Issue", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Future delivery",
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/architecture/state-machine-kernel.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nCompleted Issue #288 established the kernel, while Issue #999 remains pending implementation.\n";
  assert.deepEqual(validateDocumentationTrackers(fixture, fixtureSources), []);
});

test("shared claims apply to every explicitly referenced Issue", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Future delivery",
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/architecture/state-machine-kernel.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nCompleted Issue #288 and open Issue #999 each remain pending implementation.\n";
  assert.match(
    validateDocumentationTrackers(fixture, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("direct negated implementation claims are future residue", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nCompleted Issue #288 is not implemented.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #288 is still described as future work/u,
  );
});

test("closed Issues cannot be described as open or planned", () => {
  const { registry, sources } = repositoryFixture();
  for (const claim of ["Issue #185 remains open.", "Rejected Issue #343 is planned for release."]) {
    const fixtureSources = { ...sources };
    const path = claim.includes("343")
      ? "docs/README.md"
      : "docs/architecture/candidate-home-isolation.md";
    fixtureSources[path] += `\n${claim}\n`;
    assert.match(
      validateDocumentationTrackers(registry, fixtureSources).join("\n"),
      /closed Issue #(185|343) is still described as future work/u,
      claim,
    );
  }
});

test("adjectival open-state claims fail for closed Issues", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/candidate-home-isolation.md"] = fixtureSources[
    "docs/architecture/candidate-home-isolation.md"
  ].replace("completed Issue #185", "Open Issue #185");
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /closed Issue #185 is still described as future work/u,
  );
});

test("malformed tracker states and timestamps fail runtime validation", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.readBackAt = "2026";
  fixture.issues[0].stateReason = "NOT_PLANED" as "NOT_PLANNED";
  fixture.issues[0].closedAt = "not-a-date";
  const errors = validateDocumentationTrackers(fixture, sources).join("\n");
  assert.match(errors, /readBackAt must be an ISO timestamp/u);
  assert.match(errors, /invalid stateReason/u);
  assert.match(errors, /closedAt must be an ISO timestamp/u);
});

test("calendar-invalid timestamps fail exact read-back validation", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues[0].updatedAt = "2026-02-31T00:00:00Z";
  assert.match(
    validateDocumentationTrackers(fixture, sources).join("\n"),
    /updatedAt must be an ISO timestamp/u,
  );
});

test("tracker timestamps cannot describe events after their read-back", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues[0].updatedAt = new Date(
    new Date(fixture.readBackAt).getTime() + 1000,
  ).toISOString();
  fixture.issues[1].closedAt = "2026-08-09T07:00:00Z";
  fixture.issues[1].updatedAt = "2026-08-09T06:59:59Z";
  const errors = validateDocumentationTrackers(fixture, sources).join("\n");
  assert.match(errors, /Issue #91 updatedAt exceeds registry readBackAt/u);
  assert.match(errors, /closed Issue #94 closedAt exceeds updatedAt/u);
});

test("reopened Issues remain valid active dependencies", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Reopened delivery",
    state: "OPEN",
    stateReason: "REOPENED",
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/current-state.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/current-state.md"] += "\nOpen Issue #999 tracks remaining work.\n";
  assert.deepEqual(validateDocumentationTrackers(fixture, fixtureSources), []);
});

test("active dependencies cannot be described as completed", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Future delivery",
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/current-state.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/current-state.md"] += "\nCompleted Issue #999 delivered this behavior.\n";
  assert.match(
    validateDocumentationTrackers(fixture, fixtureSources).join("\n"),
    /docs\/current-state.md:#999 lacks explicit active dependency context/u,
  );
});

test("active keywords cannot mask contradictory completed wording", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Future delivery",
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/current-state.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/current-state.md"] += "\nOpen Issue #999 tracks the completed delivery.\n";
  assert.match(
    validateDocumentationTrackers(fixture, fixtureSources).join("\n"),
    /docs\/current-state.md:#999 contains contradictory completed dependency context/u,
  );
});

test("implemented wording contradicts an active dependency", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues.push({
    number: 999,
    title: "Future delivery",
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-08-09T07:00:00Z",
    references: [{ path: "docs/current-state.md", role: "active-dependency" }],
  });
  const fixtureSources = { ...sources };
  fixtureSources["docs/current-state.md"] +=
    "\nOpen Issue #999 is already implemented but awaits closure.\n";
  assert.match(
    validateDocumentationTrackers(fixture, fixtureSources).join("\n"),
    /docs\/current-state.md:#999 contains contradictory completed dependency context/u,
  );
});

test("durable requirements near completed Issues are not future work", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/architecture/state-machine-kernel.md"] +=
    "\nCompleted Issue #288 introduced the kernel. Existing callers must remain compatible.\n";
  assert.deepEqual(validateDocumentationTrackers(registry, fixtureSources), []);
});

test("not-planned Issues cannot be completed delivery evidence", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  const issue = fixture.issues.find((candidate) => candidate.number === 373);
  assert.ok(issue);
  issue.references[0].role = "completed-delivery";
  assert.match(
    validateDocumentationTrackers(fixture, sources).join("\n"),
    /cannot be completed delivery with stateReason NOT_PLANNED/u,
  );
});

test("unclassified and duplicate canonical references fail deterministically", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues[0].references.push({ ...fixture.issues[0].references[0] });
  const fixtureSources = { ...sources, "docs/current-state.md": "Future work: Issue #999." };
  const errors = validateDocumentationTrackers(fixture, fixtureSources).join("\n");
  assert.match(errors, /duplicate tracker reference/u);
  assert.match(errors, /unclassified canonical tracker reference: docs\/current-state.md:#999/u);
});

test("bare tracker tokens cannot bypass Issue classification", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources, "docs/current-state.md": "Future work: #288." };
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /ambiguous tracker token in docs\/current-state.md: #288/u,
  );
});

test("GitHub Issue URL schemes and hosts are case-insensitive", () => {
  const { registry, sources } = repositoryFixture();
  const fixtureSources = { ...sources };
  fixtureSources["docs/current-state.md"] +=
    "\nHistorical HTTPS://GITHUB.COM/Asuka109/mish/issues/999 was completed.\n";
  assert.match(
    validateDocumentationTrackers(registry, fixtureSources).join("\n"),
    /unclassified canonical tracker reference: docs\/current-state.md:#999/u,
  );
});
