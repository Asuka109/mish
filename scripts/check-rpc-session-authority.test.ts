import assert from "node:assert/strict";
import test from "node:test";
import {
  readRepositorySource,
  retiredRpcAuthorityFiles,
  rpcSessionConsumerFiles,
  rpcSessionContractFiles,
  validateRpcSessionAuthorityContract,
  type RpcSessionAuthoritySources,
} from "./check-rpc-session-authority.ts";

function repositorySources(): Record<string, string | undefined> {
  const paths = [
    ...rpcSessionConsumerFiles,
    ...rpcSessionContractFiles,
    ...retiredRpcAuthorityFiles,
  ];
  return Object.fromEntries(paths.map((path) => [path, readRepositorySource(path)]));
}

test("production RPC consumers and documentation satisfy the shared authority contract", () => {
  assert.deepEqual(validateRpcSessionAuthorityContract(repositorySources()), []);
});

test("a consumer-side generation guard fails closed", () => {
  const sources = repositorySources();
  sources["apps/web/src/data/rpc-status-client.ts"] +=
    "\nif (ticket.generation !== authority.getGeneration()) return;\n";
  assert.match(
    validateRpcSessionAuthorityContract(sources).join("\n"),
    /consumer-side generation comparison|consumer-side generation inspection/u,
  );
});

test("a consumer-side application-order comparison fails closed", () => {
  const sources = repositorySources();
  sources["apps/web/src/data/rpc-status-client.ts"] +=
    "\nif (next.applicationOrder.order < current.applicationOrder.order) return;\n";
  assert.match(
    validateRpcSessionAuthorityContract(sources).join("\n"),
    /consumer-side application-order comparison/u,
  );
});

test("a reintroduced local snapshot authority fails closed", () => {
  const sources = repositorySources() as RpcSessionAuthoritySources & Record<string, string>;
  sources["apps/web/src/data/application-snapshot-acceptance.ts"] =
    "export class ApplicationSnapshotAcceptance {}";
  assert.match(validateRpcSessionAuthorityContract(sources).join("\n"), /must remain deleted/u);
});
