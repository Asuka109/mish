import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface TrackerReference {
  path: string;
  role:
    | "active-dependency"
    | "completed-delivery"
    | "historical-checkpoint"
    | "superseded-decision"
    | "decision-context";
}

interface TrackerIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | null;
  closedAt: string | null;
  updatedAt: string;
  references: TrackerReference[];
}

export interface DocumentationTrackerRegistry {
  schemaVersion: number;
  repository: string;
  readBackAt: string;
  readBackSource: string;
  ordinaryCheckNetwork: string;
  canonicalPaths: string[];
  issues: TrackerIssue[];
}

const issueReferencePattern = /\bIssue\s+#(\d+)\b/gu;
const trackerTokenPattern = /#(\d+)\b/gu;
const issueUrlPattern = /\/issues\/(\d+)\b/gu;
const futureClaimPattern =
  /\b(?:future work|requires explicit|must (?:consume|remain|stay|call|wait|be implemented)|may close|ready to close|acceptance remains|integration work for|blocked by)\b/iu;
const completedContextPattern = /\b(?:accepted|closed|completed|delivered|moved|adopted)\b/iu;
const historicalContextPattern = /\b(?:historical|baseline|checkpoint|evidence|completed)\b/iu;
const supersededContextPattern = /\b(?:not planned|rejected|retired|superseded)\b/iu;
const trackerRoles = new Set([
  "active-dependency",
  "completed-delivery",
  "historical-checkpoint",
  "superseded-decision",
  "decision-context",
]);

function referenceKey(path: string, issueNumber: number): string {
  return `${path}:#${issueNumber}`;
}

function issueNumbers(source: string): Set<number> {
  const numbers = new Set(
    [...source.matchAll(issueReferencePattern)].map((match) => Number(match[1])),
  );
  for (const match of source.matchAll(issueUrlPattern)) numbers.add(Number(match[1]));
  for (const match of source.matchAll(trackerTokenPattern)) {
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 8), match.index);
    if (/\bPR\s*$/u.test(prefix)) continue;
    numbers.add(Number(match[1]));
  }
  return numbers;
}

function ambiguousTrackerTokens(source: string): number[] {
  const ambiguous: number[] = [];
  for (const match of source.matchAll(trackerTokenPattern)) {
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 8), match.index);
    if (/\b(?:Issue|PR)\s*$/u.test(prefix)) continue;
    ambiguous.push(Number(match[1]));
  }
  return ambiguous;
}

function referenceContexts(source: string, issueNumber: number): string[] {
  const lines = source.split("\n");
  const pattern = new RegExp(`\\bIssue\\s+#${issueNumber}\\b`, "u");
  const contexts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!pattern.test(line)) continue;
    contexts.push(lines.slice(Math.max(0, index - 2), index + 3).join("\n"));
  }
  return contexts;
}

export function validateDocumentationTrackers(
  registry: DocumentationTrackerRegistry,
  sources: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];
  if (registry.schemaVersion !== 1) errors.push("tracker registry schemaVersion must be 1");
  if (registry.ordinaryCheckNetwork !== "forbidden") {
    errors.push("ordinary tracker check must forbid network access");
  }
  if (!Number.isFinite(Date.parse(registry.readBackAt))) {
    errors.push("tracker registry readBackAt must be an ISO timestamp");
  }

  const canonicalPaths = new Set<string>();
  for (const path of registry.canonicalPaths) {
    if (canonicalPaths.has(path)) errors.push(`duplicate canonical path: ${path}`);
    canonicalPaths.add(path);
    if (!(path in sources)) errors.push(`missing canonical source: ${path}`);
  }

  const issueNumbersSeen = new Set<number>();
  const registeredReferences = new Map<string, TrackerReference>();
  for (const issue of registry.issues) {
    if (issueNumbersSeen.has(issue.number)) errors.push(`duplicate Issue #${issue.number}`);
    issueNumbersSeen.add(issue.number);
    if (!Number.isFinite(Date.parse(issue.updatedAt))) {
      errors.push(`Issue #${issue.number} updatedAt must be an ISO timestamp`);
    }
    if (issue.state === "OPEN") {
      if (issue.stateReason !== null || issue.closedAt !== null) {
        errors.push(`open Issue #${issue.number} must not have closure metadata`);
      }
    } else if (issue.stateReason === null || !issue.closedAt) {
      errors.push(`closed Issue #${issue.number} must include stateReason and closedAt`);
    }

    for (const reference of issue.references) {
      const key = referenceKey(reference.path, issue.number);
      if (!canonicalPaths.has(reference.path)) {
        errors.push(`${key} is outside canonicalPaths`);
      }
      if (registeredReferences.has(key)) errors.push(`duplicate tracker reference: ${key}`);
      registeredReferences.set(key, reference);

      if (!trackerRoles.has(reference.role)) {
        errors.push(`${key} has unknown tracker role: ${String(reference.role)}`);
        continue;
      }

      if (reference.role === "active-dependency" && issue.state !== "OPEN") {
        errors.push(
          `closed Issue #${issue.number} is classified as active future work in ${reference.path}`,
        );
      }
      if (reference.role !== "active-dependency" && issue.state !== "CLOSED") {
        errors.push(
          `open Issue #${issue.number} is classified as ${reference.role} in ${reference.path}`,
        );
      }

      const source = sources[reference.path];
      if (source === undefined) continue;
      const contexts = referenceContexts(source, issue.number);
      if (contexts.length === 0) {
        errors.push(`${key} is registered but not referenced as \"Issue #${issue.number}\"`);
        continue;
      }
      const context = contexts.join("\n");
      if (reference.role === "completed-delivery" && !completedContextPattern.test(context)) {
        errors.push(`${key} lacks explicit completed delivery context`);
      }
      if (reference.role === "historical-checkpoint" && !historicalContextPattern.test(context)) {
        errors.push(`${key} lacks explicit historical checkpoint context`);
      }
      if (reference.role === "superseded-decision" && !supersededContextPattern.test(context)) {
        errors.push(`${key} lacks explicit superseded or rejected context`);
      }
      if (issue.state === "CLOSED" && contexts.some((value) => futureClaimPattern.test(value))) {
        errors.push(
          `closed Issue #${issue.number} is still described as future work in ${reference.path}`,
        );
      }
    }
  }

  for (const path of canonicalPaths) {
    const source = sources[path];
    if (source === undefined) continue;
    for (const issueNumber of ambiguousTrackerTokens(source)) {
      errors.push(`ambiguous tracker token in ${path}: #${issueNumber}; use Issue # or PR #`);
    }
    for (const issueNumber of issueNumbers(source)) {
      const key = referenceKey(path, issueNumber);
      if (!registeredReferences.has(key))
        errors.push(`unclassified canonical tracker reference: ${key}`);
    }
  }

  return errors;
}

export function checkDocumentationTrackers(root = repositoryRoot): void {
  const registryPath = resolve(root, "docs/architecture/documentation-tracker-registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as DocumentationTrackerRegistry;
  const sources = Object.fromEntries(
    registry.canonicalPaths.map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
  );
  const errors = validateDocumentationTrackers(registry, sources);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (process.argv[1] === import.meta.filename) {
  checkDocumentationTrackers();
  console.log(
    "Documentation tracker registry valid: bounded canonical references match offline read-back.",
  );
}
