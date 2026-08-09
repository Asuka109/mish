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
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "" | null;
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
const githubIssueUrlPattern = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\/(\d+)\b/gu;
const futureClaimPattern =
  /\b(?:future work|follow-up work|later change|requires explicit|must (?:consume|remain|stay|call|wait|be implemented)|may close|ready to close|acceptance remains|integration work for|blocked by|(?:still )?needs (?:implementation|work|to be implemented)|remains? unimplemented|(?:is|remains?) (?:still )?(?:pending|awaiting) (?:implementation|delivery|completion|closure)|(?:has )?not yet been (?:implemented|delivered|completed|closed|shipped)|(?:is yet|remains?) to be (?:implemented|delivered|completed|closed|shipped)|(?:implementation|delivery|work) (?:is|remains) outstanding|outstanding (?:implementation|delivery|work)|will (?:(?:implement|deliver|add|complete|replace|migrate|adopt|fix|resolve|close|ship|create)|be (?:implemented|delivered|added|completed|replaced|migrated|adopted|fixed|resolved|closed|shipped|created))|is (?:the )?(?:active|future|planned) (?:implementation )?(?:plan|work|dependency))\b/iu;
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
const closedStateReasons = new Set(["COMPLETED", "NOT_PLANNED"]);

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

function referenceKey(path: string, issueNumber: number): string {
  return `${path}:#${issueNumber}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function issueNumbers(source: string, repository: string): Set<number> {
  const normalizedRepository = repository.toLowerCase();
  const numbers = new Set(
    [...source.matchAll(issueReferencePattern)].map((match) => Number(match[1])),
  );
  for (const match of source.matchAll(githubIssueUrlPattern)) {
    if (match[1]?.toLowerCase() === normalizedRepository) numbers.add(Number(match[2]));
  }
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

interface ReferenceContext {
  claim: string;
  surrounding: string;
}

function sentenceDelimiterBefore(source: string, index: number): number {
  return Math.max(
    source.lastIndexOf(". ", index),
    source.lastIndexOf("? ", index),
    source.lastIndexOf("! ", index),
  );
}

function sentenceEndAfter(source: string, index: number): number {
  const candidates = [". ", "? ", "! "]
    .map((delimiter) => source.indexOf(delimiter, index))
    .filter((candidate) => candidate !== -1);
  return candidates.length === 0 ? source.length : Math.min(...candidates) + 1;
}

function referenceContexts(
  source: string,
  repository: string,
  issueNumber: number,
): ReferenceContext[] {
  const repositoryUrl = `https://github\\.com/${escapeRegExp(repository)}/issues/${issueNumber}\\b`;
  const pattern = new RegExp(`(?:\\bIssue\\s+#${issueNumber}\\b|${repositoryUrl})`, "giu");
  const contexts: ReferenceContext[] = [];
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    const paragraphStart = source.lastIndexOf("\n\n", index - 1) + 2;
    const paragraphEndCandidate = source.indexOf("\n\n", index);
    const paragraphEnd = paragraphEndCandidate === -1 ? source.length : paragraphEndCandidate;
    const paragraph = source.slice(paragraphStart, paragraphEnd).replaceAll("\n", " ");
    const paragraphIndex = index - paragraphStart;
    const sentenceDelimiter = sentenceDelimiterBefore(paragraph, paragraphIndex - 1);
    const sentenceStart = sentenceDelimiter === -1 ? 0 : sentenceDelimiter + 2;
    const sentenceEnd = sentenceEndAfter(paragraph, paragraphIndex);
    const previousDelimiter = sentenceDelimiterBefore(paragraph, sentenceStart - 3);
    const surroundingStart = previousDelimiter === -1 ? 0 : previousDelimiter + 2;
    const surroundingEnd = sentenceEndAfter(paragraph, sentenceEnd + 1);
    contexts.push({
      claim: paragraph.slice(sentenceStart, sentenceEnd),
      surrounding: paragraph.slice(surroundingStart, surroundingEnd),
    });
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
  if (!isIsoTimestamp(registry.readBackAt)) {
    errors.push("tracker registry readBackAt must be an ISO timestamp");
  }
  const readBackTime = isIsoTimestamp(registry.readBackAt)
    ? new Date(registry.readBackAt).getTime()
    : null;

  const canonicalPaths = new Set<string>();
  for (const path of registry.canonicalPaths) {
    if (canonicalPaths.has(path)) errors.push(`duplicate canonical path: ${path}`);
    canonicalPaths.add(path);
    if (!(path in sources)) errors.push(`missing canonical source: ${path}`);
  }

  const issueNumbersSeen = new Set<number>();
  const registeredReferences = new Map<string, TrackerReference>();
  for (const issue of registry.issues) {
    if (!Number.isInteger(issue.number) || issue.number <= 0) {
      errors.push(`invalid Issue number: ${String(issue.number)}`);
    }
    if (issueNumbersSeen.has(issue.number)) errors.push(`duplicate Issue #${issue.number}`);
    issueNumbersSeen.add(issue.number);
    if (!isIsoTimestamp(issue.updatedAt)) {
      errors.push(`Issue #${issue.number} updatedAt must be an ISO timestamp`);
    } else if (readBackTime !== null && new Date(issue.updatedAt).getTime() > readBackTime) {
      errors.push(`Issue #${issue.number} updatedAt exceeds registry readBackAt`);
    }
    if (issue.state !== "OPEN" && issue.state !== "CLOSED") {
      errors.push(`Issue #${issue.number} has invalid state: ${String(issue.state)}`);
    } else if (issue.state === "OPEN") {
      if (
        issue.stateReason !== null &&
        issue.stateReason !== "" &&
        issue.stateReason !== "REOPENED"
      ) {
        errors.push(`open Issue #${issue.number} has invalid stateReason`);
      }
      if (issue.closedAt !== null) {
        errors.push(`open Issue #${issue.number} must not have closure metadata`);
      }
    } else {
      if (!closedStateReasons.has(String(issue.stateReason))) {
        errors.push(`closed Issue #${issue.number} has invalid stateReason`);
      }
      if (!isIsoTimestamp(issue.closedAt)) {
        errors.push(`closed Issue #${issue.number} closedAt must be an ISO timestamp`);
      } else if (
        isIsoTimestamp(issue.updatedAt) &&
        new Date(issue.closedAt).getTime() > new Date(issue.updatedAt).getTime()
      ) {
        errors.push(`closed Issue #${issue.number} closedAt exceeds updatedAt`);
      }
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
      if (reference.role === "completed-delivery" && issue.stateReason !== "COMPLETED") {
        errors.push(
          `Issue #${issue.number} cannot be completed delivery with stateReason ${String(issue.stateReason)}`,
        );
      }

      const source = sources[reference.path];
      if (source === undefined) continue;
      const contexts = referenceContexts(source, registry.repository, issue.number);
      if (contexts.length === 0) {
        errors.push(`${key} is registered but not referenced as \"Issue #${issue.number}\"`);
        continue;
      }
      if (
        reference.role === "completed-delivery" &&
        contexts.some((context) => !completedContextPattern.test(context.claim))
      ) {
        errors.push(`${key} lacks explicit completed delivery context`);
      }
      if (
        reference.role === "historical-checkpoint" &&
        contexts.some((context) => !historicalContextPattern.test(context.claim))
      ) {
        errors.push(`${key} lacks explicit historical checkpoint context`);
      }
      if (
        reference.role === "superseded-decision" &&
        contexts.some((context) => !supersededContextPattern.test(context.claim))
      ) {
        errors.push(`${key} lacks explicit superseded or rejected context`);
      }
      if (
        issue.state === "CLOSED" &&
        contexts.some((context) => futureClaimPattern.test(context.surrounding))
      ) {
        errors.push(
          `closed Issue #${issue.number} is still described as future work in ${reference.path}`,
        );
      }
    }
  }

  for (const path of canonicalPaths) {
    const source = sources[path];
    if (source === undefined) continue;
    const normalizedRepository = registry.repository.toLowerCase();
    for (const match of source.matchAll(githubIssueUrlPattern)) {
      if (match[1]?.toLowerCase() !== normalizedRepository) {
        errors.push(
          `external Issue URL in ${path}: ${match[1]}#${match[2]}; expected ${registry.repository}`,
        );
      }
    }
    for (const issueNumber of ambiguousTrackerTokens(source)) {
      errors.push(`ambiguous tracker token in ${path}: #${issueNumber}; use Issue # or PR #`);
    }
    for (const issueNumber of issueNumbers(source, registry.repository)) {
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
