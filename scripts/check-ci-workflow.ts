import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

type Step = { readonly name?: string; readonly run?: string; readonly uses?: string };
type Job = {
  readonly name?: string;
  readonly if?: unknown;
  readonly "runs-on"?: string;
  readonly steps?: readonly Step[];
};

const path = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const source = readFileSync(path, "utf8");
const document = parseDocument(source);
if (document.errors.length > 0)
  throw new Error(`Invalid CI workflow YAML: ${document.errors.join("; ")}`);

const forbidden =
  /(?:^|[^a-z])(?:cargo|rustc|rustfmt|clippy|tauri|src-tauri|bridge-protocol|json-rpc|mobile-core)(?:$|[^a-z])/iu;
if (forbidden.test(source))
  throw new Error("CI workflow contains retired build or protocol tooling");

const workflow = document.toJS() as { jobs?: Record<string, Job> };
const jobs = workflow.jobs ?? {};
const expected: Record<string, string> = {
  product: "Product gate",
  desktop: "Electron gate",
  mobile: "React Native gate",
};
if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
  throw new Error("CI workflow job inventory must be product, desktop, and mobile");
}
for (const [id, name] of Object.entries(expected)) {
  if (jobs[id]?.name !== name) throw new Error(`CI job ${id} must be named ${name}`);
  if ("if" in (jobs[id] ?? {})) {
    throw new Error(`CI job ${id} must not have a job-level condition`);
  }
  if (
    !jobs[id]?.steps?.some(
      (step) =>
        step.name === "Install dependencies" && step.run === "pnpm install --frozen-lockfile",
    )
  ) {
    throw new Error(`CI job ${id} must use a frozen install`);
  }
}
if (jobs.desktop?.["runs-on"] !== "macos-15") {
  throw new Error("Electron CI job must run on macos-15");
}
const product = jobs.product?.steps ?? [];
if (!product.some((step) => step.name === "Run product gate" && step.run === "pnpm check:pr")) {
  throw new Error("Product CI job must run the final product gate");
}
const desktop = jobs.desktop?.steps ?? [];
if (
  !desktop.some((step) => step.run === "pnpm desktop:check") ||
  !desktop.some((step) => step.run === "pnpm desktop:bundle:fixture")
) {
  throw new Error("Electron CI job must run checks and the bounded fixture");
}
const mobile = jobs.mobile?.steps ?? [];
if (
  !mobile.some((step) => step.run === "pnpm mobile:check") ||
  !mobile.some((step) => step.run === "pnpm mobile:android:build")
) {
  throw new Error("React Native CI job must run checks and the dual-ABI build");
}
console.log("CI workflow contains only the final TypeScript, Electron, and React Native gates.");
