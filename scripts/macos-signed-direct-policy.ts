import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  type PrivateNoFollowRoot,
} from "./release-path-containment.ts";

export const signedDirectProfile = "signed-direct" as const;
export const alphaAdHocProfile = "alpha-ad-hoc" as const;
export type MacOsReleaseProfile = typeof alphaAdHocProfile | typeof signedDirectProfile;

export const signedDirectApplicationIdentifier = "com.asuka109.mish";
export const signedDirectMihomoIdentifier = "com.asuka109.mish.mihomo";
export const signedDirectMainExecutable = "Contents/MacOS/mish-desktop";
export const signedDirectMihomoExecutable = "Contents/Resources/mihomo-aarch64-apple-darwin";
export const signedDirectSigningOrder = [signedDirectMihomoExecutable, "Mish.app"] as const;
export const protectedReleaseBoundary = "macos-developer-id" as const;

export const appleCredentialVariables = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "MISH_APPLE_CERTIFICATE_BASE64",
  "MISH_APPLE_CERTIFICATE_PASSWORD",
  "MISH_APPLE_SIGNING_IDENTITY",
  "MISH_APPLE_NOTARY_API_ISSUER_ID",
  "MISH_APPLE_NOTARY_API_KEY_ID",
  "MISH_APPLE_NOTARY_API_PRIVATE_KEY",
] as const;

export type DeveloperIdIdentity = {
  identity: string;
  teamIdentifier: string;
};

export type SignedDirectBundleEntry = {
  executable: boolean;
  kind: "directory" | "file" | "symlink";
  mode: number;
  nlink: number;
  path: string;
};

export type SignedDirectSignature = {
  entitlements: string[];
  hardenedRuntime: boolean;
  identifier: string;
  identity: string;
  path: string;
  signed: boolean;
  teamIdentifier: string;
};

export type SignedDirectEvidence = {
  advertisedTun: boolean;
  entries: SignedDirectBundleEntry[];
  expectedIdentity: DeveloperIdIdentity;
  signatures: SignedDirectSignature[];
  signingOrder: string[];
};

export type ReleaseProfileResolution =
  | {
      identity: "-";
      profile: typeof alphaAdHocProfile;
      teamIdentifier: null;
    }
  | {
      identity: string;
      profile: typeof signedDirectProfile;
      teamIdentifier: string;
    };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  invariant(
    normalized.length > 0 && !normalized.startsWith("/") && !normalized.split("/").includes(".."),
    `Bundle evidence contains an unsafe path: ${value}`,
  );
  return normalized;
}

function isPrivilegedPath(relative: string): boolean {
  const components = relative.split("/");
  const basename = components.at(-1) ?? "";
  return (
    components.includes("Library") ||
    components.includes("LaunchDaemons") ||
    components.includes("LaunchAgents") ||
    components.includes("PrivilegedHelperTools") ||
    components.includes("XPCServices") ||
    components.includes("LoginItems") ||
    /(?:^|[-_.])(?:tun|helper|smappservice|launchdaemon)(?:$|[-_.])/iu.test(basename) ||
    /(?:enrollment|installation[-_.]?key|rotation|tun-client-key)/iu.test(basename) ||
    /internal[-_. ]?tun[-_. ]?alpha/iu.test(basename)
  );
}

function isMachO(file: ReturnType<PrivateNoFollowRoot["contain"]>): boolean {
  const magic = readContainedReleaseFile(file).subarray(0, 4).toString("hex");
  file.assertCurrent();
  return new Set(["cafebabe", "cafebabf", "cffaedfe", "feedfacf", "bebafeca", "bfbafeca"]).has(
    magic,
  );
}

export async function collectSignedDirectBundleEntries(
  root: string,
  directory = root,
  rootGuard = assertPrivateNoFollowRoot(root),
): Promise<SignedDirectBundleEntry[]> {
  rootGuard.assertCurrent();
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = await Promise.all(
    entries.map(async (entry): Promise<SignedDirectBundleEntry[]> => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        const guarded = rootGuard.contain(relative, "directory");
        const metadata = await lstat(guarded.absolute);
        guarded.assertCurrent();
        return [
          {
            executable: false,
            kind: "directory",
            mode: metadata.mode,
            nlink: metadata.nlink,
            path: relative,
          },
          ...(await collectSignedDirectBundleEntries(root, guarded.absolute, rootGuard)),
        ];
      }
      const guarded = rootGuard.contain(relative, "file");
      const metadata = await lstat(guarded.absolute);
      guarded.assertCurrent();
      return [
        {
          executable: isMachO(guarded),
          kind: "file",
          mode: metadata.mode,
          nlink: metadata.nlink,
          path: relative,
        },
      ];
    }),
  );
  rootGuard.assertCurrent();
  return discovered.flat().sort((left, right) => left.path.localeCompare(right.path));
}

export function collectSignedDirectSignature(
  artifact: string,
  relative: string,
): SignedDirectSignature {
  const description = spawnSync("codesign", ["-d", "--verbose=4", artifact], {
    encoding: "utf8",
  });
  const output = `${description.stdout ?? ""}\n${description.stderr ?? ""}`;
  const entitlementDescription = spawnSync("codesign", ["-d", "--entitlements", ":-", artifact], {
    encoding: "utf8",
  });
  const entitlements = `${entitlementDescription.stdout ?? ""}\n${entitlementDescription.stderr ?? ""}`;
  return {
    entitlements: [...entitlements.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]),
    hardenedRuntime: /flags=.*\bruntime\b/iu.test(output),
    identifier: /^Identifier=(.+)$/mu.exec(output)?.[1] ?? "",
    identity: /^Authority=(Developer ID Application:.+)$/mu.exec(output)?.[1] ?? "",
    path: relative,
    signed: description.status === 0,
    teamIdentifier: /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(output)?.[1] ?? "",
  };
}

export function parseDeveloperIdApplicationIdentity(identity: string): DeveloperIdIdentity {
  invariant(
    identity === identity.trim(),
    "Developer ID Application identity must not contain surrounding whitespace",
  );
  const match = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u.exec(identity);
  invariant(
    match,
    "signed-direct requires a Developer ID Application identity ending with its 10-character team ID",
  );
  return { identity, teamIdentifier: match[1] };
}

export function resolveMacOsReleaseProfile(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): ReleaseProfileResolution {
  invariant(
    arguments_.length >= 2 &&
      arguments_[0] === "--profile" &&
      (arguments_[1] === alphaAdHocProfile || arguments_[1] === signedDirectProfile),
    "Select an explicit macOS release profile with --profile alpha-ad-hoc or --profile signed-direct",
  );
  const profile = arguments_[1] as MacOsReleaseProfile;
  const trailing = arguments_.slice(2);
  invariant(
    trailing.length === 0 ||
      (profile === alphaAdHocProfile && trailing.length === 1 && trailing[0] === "--open-dmg"),
    "The selected macOS release profile received unsupported arguments",
  );
  invariant(
    !environment.MISH_MACOS_PACKAGE_MODE && !environment.MISH_MACOS_RELEASE_PROFILE,
    "Release profile and package mode are owned by the explicit build command",
  );

  const identity = environment.APPLE_SIGNING_IDENTITY || "-";
  if (profile === alphaAdHocProfile) {
    invariant(identity === "-", "The alpha-ad-hoc profile requires APPLE_SIGNING_IDENTITY=-");
    for (const variable of appleCredentialVariables) {
      invariant(
        !environment[variable],
        `The alpha-ad-hoc profile rejects Apple credential variable ${variable}`,
      );
    }
    invariant(
      !environment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER &&
        !environment.MISH_PROTECTED_RELEASE_ENVIRONMENT,
      "The alpha-ad-hoc profile rejects protected signed-release inputs",
    );
    return { identity: "-", profile, teamIdentifier: null };
  }

  invariant(
    environment.MISH_PROTECTED_RELEASE_ENVIRONMENT === protectedReleaseBoundary,
    `signed-direct requires the protected release boundary ${protectedReleaseBoundary}`,
  );
  for (const variable of appleCredentialVariables) {
    invariant(
      !environment[variable],
      `signed-direct build execution must not receive raw credential variable ${variable}`,
    );
  }
  const parsed = parseDeveloperIdApplicationIdentity(identity);
  invariant(
    environment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER === parsed.teamIdentifier,
    "The protected release team identifier must match the selected Developer ID Application identity",
  );
  return { identity, profile, teamIdentifier: parsed.teamIdentifier };
}

export function verifySignedDirectEvidence(evidence: SignedDirectEvidence): void {
  const expectedIdentity = parseDeveloperIdApplicationIdentity(evidence.expectedIdentity.identity);
  invariant(
    expectedIdentity.teamIdentifier === evidence.expectedIdentity.teamIdentifier,
    "Expected Developer ID identity and team identifier disagree",
  );
  invariant(!evidence.advertisedTun, "signed-direct bundle must advertise TUN unavailable");
  invariant(
    JSON.stringify(evidence.signingOrder) === JSON.stringify(signedDirectSigningOrder),
    "signed-direct nested code must be signed before the application bundle",
  );

  const normalizedPaths = new Set<string>();
  const canonicalPaths = new Set<string>();
  const executablePaths = new Set<string>();
  for (const entry of evidence.entries) {
    const relative = normalizeRelativePath(entry.path);
    invariant(!normalizedPaths.has(relative), `Duplicate bundle payload path: ${relative}`);
    normalizedPaths.add(relative);
    const canonical = relative.normalize("NFC").toLocaleLowerCase("en-US");
    invariant(
      !canonicalPaths.has(canonical),
      `Case- or normalization-duplicate bundle payload path: ${relative}`,
    );
    canonicalPaths.add(canonical);
    invariant(entry.kind !== "symlink", `signed-direct bundle contains a symlink: ${relative}`);
    invariant(
      (entry.mode & 0o022) === 0,
      `signed-direct bundle contains a mutable payload: ${relative}`,
    );
    if (entry.kind === "file") {
      invariant(
        entry.nlink === 1,
        `signed-direct bundle contains duplicate hard links: ${relative}`,
      );
    }
    invariant(
      !isPrivilegedPath(relative),
      `signed-direct bundle contains privileged content: ${relative}`,
    );
    if (entry.executable) executablePaths.add(relative);
  }

  const allowedExecutables = new Set([signedDirectMainExecutable, signedDirectMihomoExecutable]);
  for (const executable of executablePaths) {
    invariant(
      allowedExecutables.has(executable),
      `signed-direct bundle contains unexpected nested code: ${executable}`,
    );
  }
  for (const expected of allowedExecutables) {
    invariant(
      executablePaths.has(expected),
      `signed-direct bundle is missing nested code: ${expected}`,
    );
  }

  const expectedSignatures = new Map([
    [
      "Mish.app",
      {
        identifier: signedDirectApplicationIdentifier,
        nested: false,
      },
    ],
    [
      signedDirectMihomoExecutable,
      {
        identifier: signedDirectMihomoIdentifier,
        nested: true,
      },
    ],
  ]);
  invariant(
    evidence.signatures.length === expectedSignatures.size,
    "signed-direct bundle contains unsigned or unexpected signed code",
  );
  const observedSignaturePaths = new Set<string>();
  for (const signature of evidence.signatures) {
    invariant(
      !observedSignaturePaths.has(signature.path),
      `Duplicate signature evidence: ${signature.path}`,
    );
    observedSignaturePaths.add(signature.path);
    const expected = expectedSignatures.get(signature.path);
    invariant(expected, `signed-direct bundle contains unexpected signed code: ${signature.path}`);
    invariant(signature.signed, `signed-direct bundle contains unsigned code: ${signature.path}`);
    invariant(
      signature.identifier === expected.identifier,
      `signed-direct signature identifier mismatch: ${signature.path}`,
    );
    invariant(
      signature.identity === expectedIdentity.identity &&
        signature.teamIdentifier === expectedIdentity.teamIdentifier,
      `signed-direct signature identity mismatch: ${signature.path}`,
    );
    invariant(
      signature.hardenedRuntime,
      `signed-direct signature is missing hardened runtime: ${signature.path}`,
    );
    invariant(
      signature.entitlements.length === 0,
      `signed-direct signature has unexpected entitlements: ${signature.path}`,
    );
  }
}
