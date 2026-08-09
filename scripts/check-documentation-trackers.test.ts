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
  fixture.issues[0].updatedAt = "2026-08-09T07:19:20Z";
  fixture.issues[1].closedAt = "2026-08-09T07:00:00Z";
  fixture.issues[1].updatedAt = "2026-08-09T06:59:59Z";
  const errors = validateDocumentationTrackers(fixture, sources).join("\n");
  assert.match(errors, /Issue #91 updatedAt exceeds registry readBackAt/u);
  assert.match(errors, /closed Issue #94 closedAt exceeds updatedAt/u);
});

test("reopened Issues remain valid active dependencies", () => {
  const { registry, sources } = repositoryFixture();
  const fixture = structuredClone(registry);
  fixture.issues[0].state = "OPEN";
  fixture.issues[0].stateReason = "REOPENED";
  fixture.issues[0].closedAt = null;
  fixture.issues[0].references[0].role = "active-dependency";
  assert.deepEqual(validateDocumentationTrackers(fixture, sources), []);
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
