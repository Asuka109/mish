import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

interface ApiResult {
  body: unknown;
  endpoint: string;
  status: number;
}

interface TrustSettingsAudit {
  repository: string;
  activationEnabled: boolean;
  status: "ready" | "disabled-fail-closed" | "unsafe";
  blockers: string[];
  observations: Record<string, unknown>;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  readFileSync(path.join(repositoryRoot, ".github/trusted-release-policy.json"), "utf8"),
) as {
  activation: { enabled: boolean };
  repository: { name: string };
};

function ghApi(endpoint: string): ApiResult {
  const result = spawnSync("gh", ["api", endpoint], {
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

function safeObservation(name: string, result: ApiResult): unknown {
  if (result.status !== 0) return { body: result.body, status: result.status };
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
        protection_rules?: unknown;
        deployment_branch_policy?: unknown;
      }>;
    };
    return {
      body: {
        environments: (body.environments ?? []).map((environment) => ({
          deployment_branch_policy: environment.deployment_branch_policy,
          name: environment.name,
          protection_rules: environment.protection_rules,
        })),
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

export function auditGitHubTrustSettings(): TrustSettingsAudit {
  const repository = policy.repository.name;
  const endpoints: Record<string, ApiResult> = {
    actions: ghApi(`repos/${repository}/actions/permissions`),
    branchProtection: ghApi(`repos/${repository}/branches/main/protection`),
    environments: ghApi(`repos/${repository}/environments`),
    oidc: ghApi(`repos/${repository}/actions/oidc/customization/sub`),
    repository: ghApi(`repos/${repository}`),
    rulesets: ghApi(`repos/${repository}/rulesets`),
    runners: ghApi(`repos/${repository}/actions/runners`),
    workflowToken: ghApi(`repos/${repository}/actions/permissions/workflow`),
  };
  endpoints.latestMainRun = ghApi(
    `repos/${repository}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=1`,
  );
  const latestMainRun = endpoints.latestMainRun.body as
    | { workflow_runs?: Array<{ id?: number }> }
    | undefined;
  const latestRunId = latestMainRun?.workflow_runs?.[0]?.id;
  endpoints.latestMainJobs = latestRunId
    ? ghApi(`repos/${repository}/actions/runs/${latestRunId}/jobs?per_page=100`)
    : { body: "No main push run found.", endpoint: "not-requested", status: 1 };
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
  if (endpoints.branchProtection.status !== 0 && endpoints.rulesets.status !== 0) {
    blockers.push("Required main-branch review and CODEOWNERS enforcement are unavailable.");
  }
  const environments = endpoints.environments.body as
    | {
        environments?: Array<{
          name?: string;
          protection_rules?: Array<{ type?: string; reviewers?: unknown[] }>;
          deployment_branch_policy?: {
            custom_branch_policies?: boolean;
            protected_branches?: boolean;
          };
        }>;
      }
    | undefined;
  const requiredEnvironments = ["macos-developer-id", "release-publication"];
  const protectedEnvironments = new Set(
    (environments?.environments ?? [])
      .filter(
        (environment) =>
          environment.protection_rules?.some(
            (rule) => rule.type === "required_reviewers" && (rule.reviewers?.length ?? 0) > 0,
          ) && environment.deployment_branch_policy?.custom_branch_policies === true,
      )
      .map((environment) => environment.name),
  );
  if (
    endpoints.environments.status !== 0 ||
    requiredEnvironments.some((name) => !protectedEnvironments.has(name))
  ) {
    blockers.push(
      "Reviewer-protected, main-only macos-developer-id and release-publication Environments are unavailable.",
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
    | { default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean }
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
    blockers.length === 0 ? "ready" : policy.activation.enabled ? "unsafe" : "disabled-fail-closed";
  return {
    activationEnabled: policy.activation.enabled,
    blockers,
    observations: Object.fromEntries(
      Object.entries(endpoints).map(([name, result]) => [name, safeObservation(name, result)]),
    ),
    repository,
    status,
  };
}

const audit = auditGitHubTrustSettings();
console.log(JSON.stringify(audit, null, 2));
if (audit.status === "unsafe") process.exitCode = 1;
