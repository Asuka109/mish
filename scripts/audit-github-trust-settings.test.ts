import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGitHubTrustSettings,
  type ApiResult,
  type TrustEndpointResults,
  type TrustPolicy,
} from "./audit-github-trust-settings.ts";

const policy: TrustPolicy = {
  activation: { enabled: false },
  actions: {
    allowed: {
      "Swatinem/rust-cache": "e18b497796c12c097a38f9edb9d0641fb99eee32",
      "actions/checkout": "d23441a48e516b6c34aea4fa41551a30e30af803",
      "android-actions/setup-android": "40fd30fb8d7440372e1316f5d1809ec01dcd3699",
      "pnpm/action-setup": "0ebf47130e4866e96fce0953f49152a61190b271",
    },
  },
  protected: {
    environments: {
      "macos-developer-id": {
        allowAdminBypass: false,
        branches: ["main"],
        preventSelfReview: false,
        requiredReviewerIds: ["18379948"],
      },
      "release-publication": {
        allowAdminBypass: false,
        branches: ["main"],
        preventSelfReview: false,
        requiredReviewerIds: ["18379948"],
      },
    },
  },
  repository: {
    defaultBranch: "main",
    name: "Asuka109/mish",
    trustedRef: "refs/heads/main",
  },
};

function result(body: unknown, status = 0): ApiResult {
  return { body, endpoint: "fixture", status };
}

function environment(name: string, reviewerId = 18_379_948) {
  return {
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
    name,
    protection_rules: [
      {
        prevent_self_review: false,
        reviewers: [{ reviewer: { id: reviewerId }, type: "User" }],
        type: "required_reviewers",
      },
    ],
  };
}

function readyEndpoints(): TrustEndpointResults {
  return {
    actions: result({
      allowed_actions: "selected",
      sha_pinning_required: true,
    }),
    branchProtection: result({
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        bypass_pull_request_allowances: {
          apps: [],
          teams: [],
          users: [],
        },
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
      },
    }),
    "environmentBranchPolicies:macos-developer-id": result({
      branch_policies: [{ name: "main", type: "branch" }],
      total_count: 1,
    }),
    "environmentBranchPolicies:release-publication": result({
      branch_policies: [{ name: "main", type: "branch" }],
      total_count: 1,
    }),
    environments: result({
      environments: [environment("macos-developer-id"), environment("release-publication")],
    }),
    latestMainJobs: result({
      jobs: [{ conclusion: "success", name: "Inspect main", steps: [{}] }],
    }),
    oidc: result({
      use_default: false,
      use_immutable_subject: true,
    }),
    rulesets: result([]),
    selectedActions: result({
      github_owned_allowed: true,
      patterns_allowed: [
        "Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32",
        "android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699",
        "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      ],
      verified_allowed: false,
    }),
    workflowToken: result({
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
    }),
  };
}

test("exact classic review and Environment protections make the audit ready", () => {
  assert.equal(evaluateGitHubTrustSettings(policy, readyEndpoints()).status, "ready");
});

test("successful but empty branch and ruleset responses fail closed", () => {
  const endpoints = readyEndpoints();
  endpoints.branchProtection = result({});
  endpoints.rulesets = result([]);
  const audit = evaluateGitHubTrustSettings(policy, endpoints);
  assert.equal(audit.status, "disabled-fail-closed");
  assert.ok(
    audit.blockers.some((blocker) => blocker.includes("main-branch review and CODEOWNERS")),
  );
});

test("an active exact-main ruleset can prove review and CODEOWNERS enforcement", () => {
  const endpoints = readyEndpoints();
  endpoints.branchProtection = result("unavailable", 1);
  endpoints.rulesets = result([{ id: 42 }]);
  endpoints["ruleset:42"] = result({
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ["refs/heads/main"],
      },
    },
    enforcement: "active",
    rules: [
      {
        parameters: {
          require_code_owner_review: true,
          required_approving_review_count: 1,
        },
        type: "pull_request",
      },
    ],
    target: "branch",
  });
  assert.equal(evaluateGitHubTrustSettings(policy, endpoints).status, "ready");
});

test("wrong reviewers or additional deployment refs fail closed", () => {
  const wrongReviewer = readyEndpoints();
  wrongReviewer.environments = result({
    environments: [environment("macos-developer-id", 999), environment("release-publication")],
  });
  assert.ok(
    evaluateGitHubTrustSettings(policy, wrongReviewer).blockers.some((blocker) =>
      blocker.includes("macos-developer-id"),
    ),
  );

  const additionalBranch = readyEndpoints();
  additionalBranch["environmentBranchPolicies:release-publication"] = result({
    branch_policies: [
      { name: "main", type: "branch" },
      { name: "feature/*", type: "branch" },
    ],
    total_count: 2,
  });
  assert.ok(
    evaluateGitHubTrustSettings(policy, additionalBranch).blockers.some((blocker) =>
      blocker.includes("release-publication"),
    ),
  );
});

test("selected third-party Actions must match the reviewed SHA allowlist", () => {
  const endpoints = readyEndpoints();
  endpoints.selectedActions = result({
    github_owned_allowed: true,
    patterns_allowed: ["pnpm/action-setup@main"],
    verified_allowed: false,
  });
  assert.ok(
    evaluateGitHubTrustSettings(policy, endpoints).blockers.some((blocker) =>
      blocker.includes("selected-action settings"),
    ),
  );
});
