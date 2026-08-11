import { createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";

const maximumBundleBytes = 16 * 1024 * 1024;
const maximumBase64Bytes = 16 * 1024 * 1024;
const maximumCertificateBytes = 1024 * 1024;
const maximumCertificateChainLength = 8;
const maximumTrustedRoots = 8;
const maximumResolvedDependencies = 128;
const fullSha = /^[0-9a-f]{40}$/u;
const sha256Digest = /^[0-9a-f]{64}$/u;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const safeString = /^[\u0020-\u007e]{1,2048}$/u;
const publicKeyDetails = "PKIX_ECDSA_P256_SHA_256";

export const sigstoreBundleMediaType = "application/vnd.dev.sigstore.bundle.v0.3+json";
export const dssePayloadType = "application/vnd.in-toto+json";
export const inTotoStatementType = "https://in-toto.io/Statement/v1";
export const slsaProvenancePredicateType = "https://slsa.dev/provenance/v1";
export const spdxPredicateType = "https://spdx.dev/Document/v2.3";
export const githubActionsWorkflowBuildType = "https://actions.github.io/buildtypes/workflow/v1";

const acceptedWorkflowBuildTypes = new Set([
  githubActionsWorkflowBuildType,
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
]);

export type AttestationTrustKey = Buffer | KeyObject | string;
export type AttestationTrustCertificate = Buffer | X509Certificate | string;

export type AttestationTrustMaterial = {
  publicKeySpki?: AttestationTrustKey;
  rootCertificates?: readonly AttestationTrustCertificate[];
};

export type AttestationExpectation = {
  artifactName: string;
  artifactSha256: string;
  predicateType: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  requireBuildIdentity: boolean;
  sourceSha: string;
  workflowRef: string;
};

export type VerifiedAttestation = {
  artifactName: string;
  artifactSha256: string;
  predicateType: string;
  signatureVerified: true;
  workflowRef: string | null;
};

export type AttestationVerificationCode =
  | "malformed"
  | "payload-type"
  | "signature-invalid"
  | "predicate-mismatch"
  | "repository-mismatch"
  | "workflow-mismatch"
  | "commit-mismatch"
  | "artifact-mismatch"
  | "trust-material-missing"
  | "untrusted-signer";

export class AttestationVerificationError extends Error {
  readonly code: AttestationVerificationCode;

  constructor(code: AttestationVerificationCode) {
    super(`Attestation rejected (${code}).`);
    this.name = "AttestationVerificationError";
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

function reject(code: AttestationVerificationCode): never {
  throw new AttestationVerificationError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, code: AttestationVerificationCode = "malformed"): JsonRecord {
  if (!isRecord(value)) reject(code);
  return value;
}

function array(value: unknown, code: AttestationVerificationCode = "malformed"): unknown[] {
  if (!Array.isArray(value)) reject(code);
  return value;
}

function boundedString(value: unknown, code: AttestationVerificationCode = "malformed"): string {
  if (typeof value !== "string" || !safeString.test(value)) reject(code);
  return value;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
  code: AttestationVerificationCode = "malformed",
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    reject(code);
  }
}

function boundedBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) reject("malformed");
  const encoded = value;
  if (
    encoded.length > maximumBase64Bytes * 2 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    reject("malformed");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== encoded) reject("malformed");
  if (decoded.length > maximumBase64Bytes) reject("malformed");
  return decoded;
}

function jsonObject(source: Buffer | string): JsonRecord {
  const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
  if (bytes.length === 0 || bytes.length > maximumBundleBytes) reject("malformed");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) reject("malformed");
  try {
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof AttestationVerificationError) throw error;
    reject("malformed");
  }
}

function publicKeyFromSpki(material: AttestationTrustKey): KeyObject {
  try {
    if (typeof material === "object" && !Buffer.isBuffer(material) && "type" in material) {
      if (material.type !== "public") reject("untrusted-signer");
      return material;
    }
    const encoded = typeof material === "string" ? Buffer.from(material, "utf8") : material;
    if (encoded.length === 0 || encoded.length > maximumCertificateBytes)
      reject("untrusted-signer");
    const isPem = encoded.toString("utf8").includes("PUBLIC KEY");
    const key = createPublicKey({
      key: encoded,
      format: isPem ? "pem" : "der",
      type: "spki",
    });
    if (key.type !== "public") reject("untrusted-signer");
    return key;
  } catch (error) {
    if (error instanceof AttestationVerificationError) throw error;
    reject("untrusted-signer");
  }
}

function assertP256Key(key: KeyObject, code: AttestationVerificationCode): void {
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    reject(code);
  }
}

function spki(key: KeyObject): Buffer {
  try {
    return key.export({ format: "der", type: "spki" });
  } catch {
    reject("untrusted-signer");
  }
}

function certificateFromMaterial(material: AttestationTrustCertificate): X509Certificate {
  try {
    if (material instanceof X509Certificate) return material;
    const encoded = typeof material === "string" ? Buffer.from(material, "utf8") : material;
    if (encoded.length === 0 || encoded.length > maximumCertificateBytes) {
      reject("untrusted-signer");
    }
    return new X509Certificate(encoded);
  } catch (error) {
    if (error instanceof AttestationVerificationError) throw error;
    reject("untrusted-signer");
  }
}

function signerCertificateFromVerificationMaterial(verificationMaterial: JsonRecord): {
  certificate: X509Certificate | null;
  key: KeyObject;
} {
  exactKeys(
    verificationMaterial,
    [],
    [
      "certificate",
      "ctlogEntries",
      "publicKey",
      "timestampVerificationData",
      "tlogEntries",
      "x509CertificateChain",
    ],
  );
  const sources = [
    verificationMaterial.certificate,
    verificationMaterial.publicKey,
    verificationMaterial.x509CertificateChain,
  ].filter((source) => source !== undefined);
  if (sources.length !== 1) reject("malformed");

  if (verificationMaterial.publicKey !== undefined) {
    const publicKey = record(verificationMaterial.publicKey);
    exactKeys(publicKey, ["keyDetails", "rawBytes"], ["hint"]);
    if (publicKey.keyDetails !== publicKeyDetails) reject("signature-invalid");
    const key = publicKeyFromSpki(boundedBase64(publicKey.rawBytes));
    assertP256Key(key, "signature-invalid");
    return { certificate: null, key };
  }

  if (verificationMaterial.certificate !== undefined) {
    const certificate = record(verificationMaterial.certificate);
    exactKeys(certificate, ["rawBytes"]);
    const parsed = certificateFromMaterial(boundedBase64(certificate.rawBytes));
    assertP256Key(parsed.publicKey, "signature-invalid");
    return { certificate: parsed, key: parsed.publicKey };
  }

  const chain = record(verificationMaterial.x509CertificateChain);
  exactKeys(chain, ["certificates"]);
  const certificates = array(chain.certificates);
  if (certificates.length === 0 || certificates.length > maximumCertificateChainLength) {
    reject("malformed");
  }
  const parsed = certificates.map((candidate) => {
    const entry = record(candidate);
    exactKeys(entry, ["rawBytes"]);
    return certificateFromMaterial(boundedBase64(entry.rawBytes));
  });
  assertP256Key(parsed[0].publicKey, "signature-invalid");
  return { certificate: parsed[0], key: parsed[0].publicKey };
}

function validateCertificateChain(
  leaf: X509Certificate,
  verificationMaterial: JsonRecord,
  roots: readonly X509Certificate[],
): void {
  const chainValue = verificationMaterial.x509CertificateChain;
  const certificates =
    chainValue === undefined
      ? [leaf]
      : array(record(chainValue).certificates).map((candidate) => {
          const entry = record(candidate);
          exactKeys(entry, ["rawBytes"]);
          return certificateFromMaterial(boundedBase64(entry.rawBytes));
        });
  if (certificates.length === 0 || certificates.length > maximumCertificateChainLength) {
    reject("untrusted-signer");
  }
  for (let index = 0; index + 1 < certificates.length; index += 1) {
    if (!certificates[index + 1].ca) reject("untrusted-signer");
    if (!certificates[index].verify(certificates[index + 1].publicKey)) {
      reject("untrusted-signer");
    }
  }
  const last = certificates.at(-1);
  if (
    !last ||
    !roots.some((root) => root.ca && (last.raw.equals(root.raw) || last.verify(root.publicKey)))
  ) {
    reject("untrusted-signer");
  }
}

function validateTrust(
  verificationMaterial: JsonRecord,
  signer: { certificate: X509Certificate | null; key: KeyObject },
  trust: AttestationTrustMaterial,
): void {
  const trustRecord = record(trust, "trust-material-missing");
  exactKeys(trustRecord, [], ["publicKeySpki", "rootCertificates"], "trust-material-missing");
  const hasPublicKey = trustRecord.publicKeySpki !== undefined;
  const rootsValue = trustRecord.rootCertificates;
  const roots =
    rootsValue === undefined
      ? []
      : array(rootsValue, "trust-material-missing").map((root) =>
          certificateFromMaterial(root as AttestationTrustCertificate),
        );
  if (roots.length > maximumTrustedRoots) reject("trust-material-missing");
  if (!hasPublicKey && roots.length === 0) reject("trust-material-missing");
  if (hasPublicKey) {
    const expected = publicKeyFromSpki(trustRecord.publicKeySpki as AttestationTrustKey);
    assertP256Key(expected, "untrusted-signer");
    if (!spki(expected).equals(spki(signer.key))) reject("untrusted-signer");
  }
  if (signer.certificate && roots.length > 0) {
    validateCertificateChain(signer.certificate, verificationMaterial, roots);
  } else if (!signer.certificate && roots.length > 0) {
    reject("untrusted-signer");
  }
}

function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1 ", "utf8"),
    Buffer.from(`${type.length} `, "ascii"),
    type,
    Buffer.from(` ${payload.length} `, "ascii"),
    payload,
  ]);
}

function verifySignature(
  envelope: JsonRecord,
  signerKey: KeyObject,
): { payload: Buffer; payloadType: string } {
  exactKeys(envelope, ["payload", "payloadType", "signatures"]);
  const payload = boundedBase64(envelope.payload);
  const payloadType = boundedString(envelope.payloadType, "payload-type");
  if (payloadType !== dssePayloadType) reject("payload-type");
  const signatures = array(envelope.signatures);
  if (signatures.length !== 1) reject("signature-invalid");
  const signature = record(signatures[0]);
  exactKeys(signature, ["sig"], ["keyid"]);
  const signatureBytes = boundedBase64(signature.sig);
  if (!verify("sha256", pae(payloadType, payload), signerKey, signatureBytes)) {
    reject("signature-invalid");
  }
  return { payload, payloadType };
}

function validateExpectation(expectation: AttestationExpectation): void {
  const workflowPrefix = `${expectation.repository}/.github/workflows/`;
  const workflowSeparator = expectation.workflowRef.indexOf("@");
  if (
    !repositoryName.test(expectation.repository) ||
    !fullSha.test(expectation.sourceSha) ||
    !sha256Digest.test(expectation.artifactSha256) ||
    !safeString.test(expectation.artifactName) ||
    !safeString.test(expectation.predicateType) ||
    !safeString.test(expectation.workflowRef) ||
    !expectation.workflowRef.startsWith(workflowPrefix) ||
    workflowSeparator <= workflowPrefix.length ||
    !/^refs\/[A-Za-z0-9._/-]+$/u.test(expectation.workflowRef.slice(workflowSeparator + 1)) ||
    !/^[A-Za-z0-9._/-]+$/u.test(
      expectation.workflowRef.slice(workflowPrefix.length, workflowSeparator),
    ) ||
    typeof expectation.requireBuildIdentity !== "boolean" ||
    !/^\d+$/u.test(expectation.repositoryId) ||
    !/^\d+$/u.test(expectation.repositoryOwnerId)
  ) {
    reject("malformed");
  }
}

function validateSubject(statement: JsonRecord, expectation: AttestationExpectation): void {
  const subjects = array(statement.subject, "artifact-mismatch");
  if (subjects.length !== 1) reject("artifact-mismatch");
  const subject = record(subjects[0], "artifact-mismatch");
  exactKeys(subject, ["name", "digest"], [], "artifact-mismatch");
  if (subject.name !== expectation.artifactName) reject("artifact-mismatch");
  const digest = record(subject.digest, "artifact-mismatch");
  exactKeys(digest, ["sha256"], [], "artifact-mismatch");
  if (digest.sha256 !== expectation.artifactSha256) reject("artifact-mismatch");
}

function validateBuildIdentity(
  statement: JsonRecord,
  expectation: AttestationExpectation,
  certificate: X509Certificate | null,
): void {
  const predicate = record(statement.predicate, "predicate-mismatch");
  exactKeys(predicate, ["buildDefinition", "runDetails"], [], "predicate-mismatch");
  const buildDefinition = record(predicate.buildDefinition, "predicate-mismatch");
  exactKeys(
    buildDefinition,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    [],
    "predicate-mismatch",
  );
  if (
    typeof buildDefinition.buildType !== "string" ||
    !acceptedWorkflowBuildTypes.has(buildDefinition.buildType)
  ) {
    reject("predicate-mismatch");
  }

  const externalParameters = record(buildDefinition.externalParameters, "workflow-mismatch");
  exactKeys(externalParameters, ["workflow"], [], "workflow-mismatch");
  const workflow = record(externalParameters.workflow, "workflow-mismatch");
  exactKeys(workflow, ["path", "ref", "repository"], [], "workflow-mismatch");
  const workflowPath = boundedString(workflow.path, "workflow-mismatch");
  const workflowBranch = boundedString(workflow.ref, "workflow-mismatch");
  const workflowRepository = boundedString(workflow.repository, "repository-mismatch");
  if (workflowRepository !== `https://github.com/${expectation.repository}`) {
    reject("repository-mismatch");
  }
  const expectedWorkflowRef = `${expectation.repository}/${workflowPath}@${workflowBranch}`;
  if (expectedWorkflowRef !== expectation.workflowRef) reject("workflow-mismatch");

  const internalParameters = record(buildDefinition.internalParameters, "repository-mismatch");
  exactKeys(internalParameters, ["github"], [], "repository-mismatch");
  const github = record(internalParameters.github, "repository-mismatch");
  exactKeys(
    github,
    ["event_name", "repository_id", "repository_owner_id"],
    ["runner_environment"],
    "repository-mismatch",
  );
  if (
    github.event_name !== "workflow_dispatch" ||
    github.repository_id !== expectation.repositoryId ||
    github.repository_owner_id !== expectation.repositoryOwnerId
  ) {
    reject("repository-mismatch");
  }
  if (github.runner_environment !== undefined && github.runner_environment !== "github-hosted") {
    reject("workflow-mismatch");
  }

  const dependencies = array(buildDefinition.resolvedDependencies, "commit-mismatch");
  if (dependencies.length === 0 || dependencies.length > maximumResolvedDependencies) {
    reject("commit-mismatch");
  }
  const expectedDependencyUris = new Set([
    `git+https://github.com/${expectation.repository}@${workflowBranch}`,
    `https://github.com/${expectation.repository}@${workflowBranch}`,
    `git+https://github.com/${expectation.repository}.git@${workflowBranch}`,
    `https://github.com/${expectation.repository}.git@${workflowBranch}`,
  ]);
  const matchingDependencies = dependencies.filter((candidate) => {
    const dependency = record(candidate, "commit-mismatch");
    exactKeys(dependency, ["digest", "uri"], [], "commit-mismatch");
    const digest = record(dependency.digest, "commit-mismatch");
    exactKeys(digest, ["gitCommit"], [], "commit-mismatch");
    const uri = boundedString(dependency.uri, "commit-mismatch");
    return expectedDependencyUris.has(uri);
  });
  if (matchingDependencies.length !== 1) reject("commit-mismatch");
  const matchingDependency = record(matchingDependencies[0], "commit-mismatch");
  const matchingDigest = record(matchingDependency.digest, "commit-mismatch").gitCommit;
  if (matchingDigest !== expectation.sourceSha) reject("commit-mismatch");

  const runDetails = record(predicate.runDetails, "predicate-mismatch");
  exactKeys(runDetails, ["builder", "metadata"], [], "predicate-mismatch");
  const builder = record(runDetails.builder, "predicate-mismatch");
  exactKeys(builder, ["id"], [], "predicate-mismatch");
  const builderId = boundedString(builder.id, "predicate-mismatch");
  if (
    builderId !== `https://github.com/${expectation.workflowRef}` &&
    builderId !== "https://github.com/actions/runner/github-hosted"
  ) {
    reject("workflow-mismatch");
  }
  const metadata = record(runDetails.metadata, "predicate-mismatch");
  exactKeys(metadata, ["invocationId"], [], "predicate-mismatch");
  const invocationId = boundedString(metadata.invocationId, "predicate-mismatch");
  if (!invocationId.startsWith(`https://github.com/${expectation.repository}/actions/runs/`)) {
    reject("workflow-mismatch");
  }

  if (certificate) {
    const expectedSan = `URI:https://github.com/${expectation.workflowRef}`;
    const san = certificate.subjectAltName?.split(",").map((entry: string) => entry.trim()) ?? [];
    if (!san.includes(expectedSan)) reject("workflow-mismatch");
  }
}

function validateStatement(
  payload: Buffer,
  expectation: AttestationExpectation,
  certificate: X509Certificate | null,
): VerifiedAttestation {
  let statement: JsonRecord;
  try {
    const text = payload.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(payload)) reject("malformed");
    statement = record(JSON.parse(text));
  } catch (error) {
    if (error instanceof AttestationVerificationError) throw error;
    reject("malformed");
  }
  exactKeys(statement, ["_type", "predicate", "predicateType", "subject"]);
  if (statement._type !== inTotoStatementType) reject("payload-type");
  if (statement.predicateType !== expectation.predicateType) reject("predicate-mismatch");
  validateSubject(statement, expectation);
  if (expectation.requireBuildIdentity) validateBuildIdentity(statement, expectation, certificate);
  else {
    const predicate = record(statement.predicate, "predicate-mismatch");
    if (expectation.predicateType === spdxPredicateType && predicate.spdxVersion !== "SPDX-2.3") {
      reject("predicate-mismatch");
    }
  }
  return {
    artifactName: expectation.artifactName,
    artifactSha256: expectation.artifactSha256,
    predicateType: expectation.predicateType,
    signatureVerified: true,
    workflowRef: expectation.requireBuildIdentity ? expectation.workflowRef : null,
  };
}

export function verifyTrustedAttestation(
  source: Buffer | string,
  expectation: AttestationExpectation,
  trust: AttestationTrustMaterial,
): VerifiedAttestation {
  try {
    validateExpectation(expectation);
    const bundle = jsonObject(source);
    exactKeys(bundle, ["dsseEnvelope", "mediaType", "verificationMaterial"]);
    if (bundle.mediaType !== sigstoreBundleMediaType) reject("malformed");
    const verificationMaterial = record(bundle.verificationMaterial, "malformed");
    const signer = signerCertificateFromVerificationMaterial(verificationMaterial);
    validateTrust(verificationMaterial, signer, trust);
    const envelope = record(bundle.dsseEnvelope, "malformed");
    const verified = verifySignature(envelope, signer.key);
    return validateStatement(verified.payload, expectation, signer.certificate);
  } catch (error) {
    if (error instanceof AttestationVerificationError) throw error;
    reject("malformed");
  }
}
