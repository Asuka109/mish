import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ApiResult {
  body: unknown;
  endpoint: string;
  status: number;
}

interface EnvironmentPolicy {
  requiredReviewerIds: string[];
  preventSelfReview: boolean;
  allowAdminBypass: boolean;
  branches: string[];
}

export interface TrustPolicy {
  activation: { enabled: boolean };
  actions: {
    allowed: Record<string, string>;
  };
  repository: {
    name: string;
    defaultBranch: string;
    trustedRef: string;
  };
  protected: {
    environments: Record<string, EnvironmentPolicy>;
  };
}

export interface TrustSettingsAudit {
  repository: string;
  activationEnabled: boolean;
  status: "ready" | "disabled-fail-closed" | "unsafe";
  blockers: string[];
  observations: Record<string, unknown>;
}

export type TrustEndpointResults = Record<string, ApiResult>;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  readFileSync(path.join(repositoryRoot, ".github/trusted-release-policy.json"), "utf8"),
) as TrustPolicy;

function ghApi(endpoint: string): ApiResult {
  const result = spawnSync("gh", ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const source = result.stdout.trim() || result.stderr.trim();
  let body: unknown = source;
  try {
    body = JSON.parse(source);
  } catch {
    // Retain bounded gh diagnostics when GitHub does not return JSON.
  }
  return {
    body,
    endpoint,
    status: result.status ?? 1,
  };
}

function rulesetEndpointName(id: number): string {
  return `ruleset:${id}`;
}

function environmentPoliciesEndpointName(name: string): string {
  return `environmentBranchPolicies:${name}`;
}

function safeObservation(name: string, result: ApiResult): unknown {
  if (result.status !== 0) return { body: result.body, status: result.status };
  if (name === "actions") {
    const body = result.body as Record<string, unknown>;
    return {
      body: {
        allowed_actions: body.allowed_actions,
        enabled: body.enabled,
        sha_pinning_required: body.sha_pinning_required,
      },
      status: result.status,
    };
  }
  if (name === "selectedActions") {
    const body = result.body as Record<string, unknown>;
    return {
      body: {
        github_owned_allowed: body.github_owned_allowed,
        patterns_allowed: body.patterns_allowed,
        verified_allowed: body.verified_allowed,
      },
      status: result.status,
    };
  }
  if (name === "branchProtection") {
    const body = result.body as {
      enforce_admins?: { enabled?: boolean };
      required_pull_request_reviews?: {
        bypass_pull_request_allowances?: {
          apps?: unknown[];
          teams?: unknown[];
          users?: unknown[];
        };
        require_code_owner_reviews?: boolean;
        required_approving_review_count?: number;
      };
    };
    return {
      body: {
        enforce_admins: body.enforce_admins,
        required_pull_request_reviews: body.required_pull_request_reviews
          ? {
              bypass_pull_request_allowances:
                body.required_pull_request_reviews.bypass_pull_request_allowances,
              require_code_owner_reviews:
                body.required_pull_request_reviews.require_code_owner_reviews,
              required_approving_review_count:
                body.required_pull_request_reviews.required_approving_review_count,
            }
          : undefined,
      },
      status: result.status,
    };
  }
  if (name === "repository") {
    const body = result.body as Record<string, unknown>;
    return {
      body: {
        default_branch: body.default_branch,
        full_name: body.full_name,
        id: body.id,
        private: body.private,
        visibility: body.visibility,
      },
      status: result.status,
    };
  }
  if (name === "environments") {
    const body = result.body as {
      environments?: Array<{
        name?: string;
        protection_rules?: Array<{
          prevent_self_review?: boolean;
          reviewers?: Array<{
            reviewer?: { id?: number };
            type?: string;
          }>;
          type?: string;
        }>;
        deployment_branch_policy?: unknown;
      }>;
    };
    return {
      body: {
        environments: (body.environments ?? []).map((environment) => ({
          deployment_branch_policy: environment.deployment_branch_policy,
          name: environment.name,
          protection_rules: (environment.protection_rules ?? []).map((rule) => ({
            prevent_self_review: rule.prevent_self_review,
            reviewers: (rule.reviewers ?? []).map((reviewer) => ({
              id: reviewer.reviewer?.id,
              type: reviewer.type,
            })),
            type: rule.type,
          })),
        })),
      },
      status: result.status,
    };
  }
  if (name === "rulesets") {
    const body = result.body as Array<{
      enforcement?: string;
      id?: number;
      name?: string;
      target?: string;
    }>;
    return {
      body: body.map((ruleset) => ({
        enforcement: ruleset.enforcement,
        id: ruleset.id,
        name: ruleset.name,
        target: ruleset.target,
      })),
      status: result.status,
    };
  }
  if (name.startsWith("ruleset:")) {
    const body = result.body as {
      bypass_actors?: unknown[];
      conditions?: { ref_name?: { exclude?: string[]; include?: string[] } };
      enforcement?: string;
      id?: number;
      rules?: Array<{ parameters?: Record<string, unknown>; type?: string }>;
      target?: string;
    };
    return {
      body: {
        bypass_actor_count: body.bypass_actors?.length,
        conditions: body.conditions,
        enforcement: body.enforcement,
        id: body.id,
        pull_request_rule: body.rules?.find((rule) => rule.type === "pull_request"),
        target: body.target,
      },
      status: result.status,
    };
  }
  if (name.startsWith("environmentBranchPolicies:")) {
    const body = result.body as {
      branch_policies?: Array<{ name?: string; type?: string }>;
      total_count?: number;
    };
    return {
      body: {
        branch_policies: (body.branch_policies ?? []).map((branch) => ({
          name: branch.name,
          type: branch.type,
        })),
        total_count: body.total_count,
      },
      status: result.status,
    };
  }
  if (name === "runners") {
    const body = result.body as {
      runners?: Array<{
        labels?: Array<{ name?: string }>;
        name?: string;
        os?: string;
        status?: string;
      }>;
      total_count?: number;
    };
    return {
      body: {
        runners: (body.runners ?? []).map((runner) => ({
          labels: (runner.labels ?? []).map((label) => label.name),
          name: runner.name,
          os: runner.os,
          status: runner.status,
        })),
        total_count: body.total_count,
      },
      status: result.status,
    };
  }
  if (name === "latestMainRun") {
    const body = result.body as {
      workflow_runs?: Array<{
        conclusion?: string;
        head_sha?: string;
        html_url?: string;
        id?: number;
        status?: string;
      }>;
    };
    return {
      body: {
        workflow_runs: (body.workflow_runs ?? []).map((run) => ({
          conclusion: run.conclusion,
          head_sha: run.head_sha,
          html_url: run.html_url,
          id: run.id,
          status: run.status,
        })),
      },
      status: result.status,
    };
  }
  if (name === "latestMainJobs") {
    const body = result.body as {
      jobs?: Array<{
        conclusion?: string;
        name?: string;
        status?: string;
        steps?: unknown[];
      }>;
    };
    return {
      body: {
        jobs: (body.jobs ?? []).map((job) => ({
          conclusion: job.conclusion,
          name: job.name,
          status: job.status,
          step_count: job.steps?.length ?? 0,
        })),
      },
      status: result.status,
    };
  }
  return { body: result.body, status: result.status };
}

export function collectGitHubTrustEndpoints(
  trustPolicy: TrustPolicy = policy,
  api: (endpoint: string) => ApiResult = ghApi,
): TrustEndpointResults {
  const repository = trustPolicy.repository.name;
  const endpoints: TrustEndpointResults = {
    actions: api(`repos/${repository}/actions/permissions`),
    branchProtection: api(
      `repos/${repository}/branches/${encodeURIComponent(trustPolicy.repository.defaultBranch)}/protection`,
    ),
    environments: api(`repos/${repository}/environments?per_page=100`),
    oidc: api(`repos/${repository}/actions/oidc/customization/sub`),
    repository: api(`repos/${repository}`),
    rulesets: api(`repos/${repository}/rulesets?includes_parents=true&per_page=100`),
    selectedActions: api(`repos/${repository}/actions/permissions/selected-actions`),
    workflowToken: api(`repos/${repository}/actions/permissions/workflow`),
  };

  const rulesets =
    endpoints.rulesets.status === 0 ? (endpoints.rulesets.body as Array<{ id?: number }>) : [];
  for (const ruleset of rulesets) {
    if (!Number.isInteger(ruleset.id)) continue;
    endpoints[rulesetEndpointName(ruleset.id as number)] = api(
      `repos/${repository}/rulesets/${ruleset.id}?includes_parents=true`,
    );
  }

  for (const environment of Object.keys(trustPolicy.protected.environments)) {
    endpoints[environmentPoliciesEndpointName(environment)] = api(
      `repos/${repository}/environments/${encodeURIComponent(environment)}/deployment-branch-policies?per_page=100`,
    );
  }

  endpoints.latestMainRun = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?event=push&branch=${encodeURIComponent(trustPolicy.repository.defaultBranch)}&per_page=1`,
  );
  const latestMainRun = endpoints.latestMainRun.body as
    | { workflow_runs?: Array<{ id?: number }> }
    | undefined;
  const latestRunId = latestMainRun?.workflow_runs?.[0]?.id;
  endpoints.latestMainJobs = latestRunId
    ? api(`repos/${repository}/actions/runs/${latestRunId}/jobs?per_page=100`)
    : { body: "No main push run found.", endpoint: "not-requested", status: 1 };
  return endpoints;
}

function isClassicMainReviewProtected(result: ApiResult): boolean {
  if (result.status !== 0) return false;
  const body = result.body as {
    enforce_admins?: { enabled?: boolean };
    required_pull_request_reviews?: {
      bypass_pull_request_allowances?: {
        apps?: unknown[];
        teams?: unknown[];
        users?: unknown[];
      };
      require_code_owner_reviews?: boolean;
      required_approving_review_count?: number;
    };
  };
  const reviews = body.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  return (
    body.enforce_admins?.enabled === true &&
    reviews?.require_code_owner_reviews === true &&
    (reviews.required_approving_review_count ?? 0) >= 1 &&
    bypass !== undefined &&
    (bypass?.apps?.length ?? 0) === 0 &&
    (bypass?.teams?.length ?? 0) === 0 &&
    (bypass?.users?.length ?? 0) === 0
  );
}

function isActiveMainReviewRuleset(result: ApiResult, defaultBranch: string): boolean {
  if (result.status !== 0) return false;
  const body = result.body as {
    bypass_actors?: unknown[];
    conditions?: { ref_name?: { exclude?: string[]; include?: string[] } };
    enforcement?: string;
    rules?: Array<{
      parameters?: {
        require_code_owner_review?: boolean;
        required_approving_review_count?: number;
      };
      type?: string;
    }>;
    target?: string;
  };
  const refs = body.conditions?.ref_name;
  const acceptedIncludes = new Set(["~ALL", "~DEFAULT_BRANCH", `refs/heads/${defaultBranch}`]);
  const pullRequestRule = body.rules?.find((rule) => rule.type === "pull_request");
  return (
    body.target === "branch" &&
    body.enforcement === "active" &&
    Array.isArray(body.bypass_actors) &&
    body.bypass_actors.length === 0 &&
    (refs?.include ?? []).some((entry) => acceptedIncludes.has(entry)) &&
    (refs?.exclude?.length ?? 0) === 0 &&
    pullRequestRule?.parameters?.require_code_owner_review === true &&
    (pullRequestRule.parameters.required_approving_review_count ?? 0) >= 1
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function isExactEnvironmentProtected(
  trustPolicy: TrustPolicy,
  endpoints: TrustEndpointResults,
  environmentName: string,
): boolean {
  if (endpoints.environments.status !== 0) return false;
  const expected = trustPolicy.protected.environments[environmentName];
  const body = endpoints.environments.body as {
    environments?: Array<{
      deployment_branch_policy?: {
        custom_branch_policies?: boolean;
        protected_branches?: boolean;
      };
      name?: string;
      protection_rules?: Array<{
        prevent_self_review?: boolean;
        reviewers?: Array<{ reviewer?: { id?: number } }>;
        type?: string;
      }>;
    }>;
  };
  const environment = body.environments?.find((candidate) => candidate.name === environmentName);
  const reviewerRule = environment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  const reviewerIds = (reviewerRule?.reviewers ?? []).flatMap((reviewer) =>
    reviewer.reviewer?.id === undefined ? [] : [String(reviewer.reviewer.id)],
  );
  const branchResult = endpoints[environmentPoliciesEndpointName(environmentName)];
  if (!branchResult || branchResult.status !== 0) return false;
  const branchBody = branchResult.body as {
    branch_policies?: Array<{ name?: string; type?: string }>;
  };
  const branchPolicies = branchBody.branch_policies ?? [];
  const branchNames = branchPolicies.flatMap((branch) =>
    branch.name === undefined ? [] : [branch.name],
  );
  return (
    reviewerRule?.prevent_self_review === expected.preventSelfReview &&
    sameStrings(reviewerIds, expected.requiredReviewerIds) &&
    environment?.deployment_branch_policy?.custom_branch_policies === true &&
    environment.deployment_branch_policy.protected_branches === false &&
    branchPolicies.every((branch) => branch.type === undefined || branch.type === "branch") &&
    branchPolicies.length === expected.branches.length &&
    sameStrings(branchNames, expected.branches)
  );
}

export function evaluateGitHubTrustSettings(
  trustPolicy: TrustPolicy,
  endpoints: TrustEndpointResults,
): TrustSettingsAudit {
  const blockers: string[] = [];
  const actions = endpoints.actions.body as
    | { allowed_actions?: string; sha_pinning_required?: boolean }
    | undefined;
  if (
    endpoints.actions.status !== 0 ||
    actions?.allowed_actions !== "selected" ||
    actions.sha_pinning_required !== true
  ) {
    blockers.push(
      "Repository Actions settings do not enforce a selected allowlist and full commit SHA pinning.",
    );
  }
  const selectedActions = endpoints.selectedActions.body as
    | {
        github_owned_allowed?: boolean;
        patterns_allowed?: string[];
        verified_allowed?: boolean;
      }
    | undefined;
  const expectedThirdPartyActions = Object.entries(trustPolicy.actions.allowed)
    .filter(([name]) => !name.startsWith("actions/"))
    .map(([name, sha]) => `${name}@${sha}`)
    .sort();
  if (
    endpoints.selectedActions.status !== 0 ||
    selectedActions?.github_owned_allowed !== true ||
    selectedActions.verified_allowed !== false ||
    !sameStrings(selectedActions.patterns_allowed ?? [], expectedThirdPartyActions)
  ) {
    blockers.push(
      "Repository selected-action settings do not exactly allow GitHub-owned actions plus the reviewed third-party SHA pins.",
    );
  }

  const rulesetProtectsMain = Object.entries(endpoints)
    .filter(([name]) => name.startsWith("ruleset:"))
    .some(([, result]) => isActiveMainReviewRuleset(result, trustPolicy.repository.defaultBranch));
  if (!isClassicMainReviewProtected(endpoints.branchProtection) && !rulesetProtectsMain) {
    blockers.push(
      "Required main-branch review and CODEOWNERS enforcement are unavailable or do not match the fail-closed policy.",
    );
  }

  const unprotectedEnvironments = Object.keys(trustPolicy.protected.environments).filter(
    (name) => !isExactEnvironmentProtected(trustPolicy, endpoints, name),
  );
  if (unprotectedEnvironments.length > 0) {
    blockers.push(
      `Reviewer-protected, main-only Environments do not exactly match policy: ${unprotectedEnvironments.join(", ")}.`,
    );
  }

  const oidc = endpoints.oidc.body as
    | { use_default?: boolean; use_immutable_subject?: boolean }
    | undefined;
  if (
    endpoints.oidc.status !== 0 ||
    oidc?.use_default !== false ||
    oidc.use_immutable_subject !== true
  ) {
    blockers.push("OIDC subject customization does not bind the protected workflow identity.");
  }
  const workflowToken = endpoints.workflowToken.body as
    | {
        default_workflow_permissions?: string;
        can_approve_pull_request_reviews?: boolean;
      }
    | undefined;
  if (
    endpoints.workflowToken.status !== 0 ||
    workflowToken?.default_workflow_permissions !== "read" ||
    workflowToken.can_approve_pull_request_reviews !== false
  ) {
    blockers.push("Default workflow token permissions are not read-only and review-disabled.");
  }
  const latestJobs = endpoints.latestMainJobs.body as
    | {
        jobs?: Array<{
          conclusion?: string;
          name?: string;
          steps?: unknown[];
        }>;
      }
    | undefined;
  const allocatedMainJobs = (latestJobs?.jobs ?? []).filter(
    (job) => job.conclusion !== "skipped" && (job.steps?.length ?? 0) > 0,
  );
  if (endpoints.latestMainJobs.status !== 0 || allocatedMainJobs.length === 0) {
    blockers.push(
      "The latest main push has no allocated runner job, so no hosted or protected gate execution is evidenced.",
    );
  }
  const status =
    blockers.length === 0
      ? "ready"
      : trustPolicy.activation.enabled
        ? "unsafe"
        : "disabled-fail-closed";
  return {
    activationEnabled: trustPolicy.activation.enabled,
    blockers,
    observations: Object.fromEntries(
      Object.entries(endpoints).map(([name, result]) => [name, safeObservation(name, result)]),
    ),
    repository: trustPolicy.repository.name,
    status,
  };
}

export function auditGitHubTrustSettings(): TrustSettingsAudit {
  return evaluateGitHubTrustSettings(policy, collectGitHubTrustEndpoints(policy));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const audit = auditGitHubTrustSettings();
  console.log(JSON.stringify(audit, null, 2));
  if (audit.status === "unsafe") process.exitCode = 1;
}
