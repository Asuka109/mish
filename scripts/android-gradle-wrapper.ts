export const androidGradleDistribution = Object.freeze({
  version: "8.14.3",
  distributionUrl: "https://services.gradle.org/distributions/gradle-8.14.3-bin.zip",
  distributionSha256Sum: "bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531",
  checksumSource: "https://gradle.org/release-checksums/#8.14.3",
});

const criticalProperty = /^\s*(distributionUrl|distributionSha256Sum)(?:\s*[=:]\s*|\s+)(.*)$/u;

function wrapperDistributionUrl() {
  return androidGradleDistribution.distributionUrl.replace(":", "\\:");
}

function canonicalPropertyLines() {
  return [
    `distributionUrl=${wrapperDistributionUrl()}`,
    `distributionSha256Sum=${androidGradleDistribution.distributionSha256Sum}`,
  ];
}

function mappingErrors(): string[] {
  const expectedUrl = `https://services.gradle.org/distributions/gradle-${androidGradleDistribution.version}-bin.zip`;
  const errors: string[] = [];

  if (androidGradleDistribution.distributionUrl !== expectedUrl) {
    errors.push("The canonical Gradle version and binary distribution URL do not match.");
  }
  if (!/^[0-9a-f]{64}$/u.test(androidGradleDistribution.distributionSha256Sum)) {
    errors.push("The canonical Gradle distribution SHA-256 is malformed.");
  }

  return errors;
}

export function pinAndroidGradleWrapper(source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingEol = /\r?\n$/u.test(source);
  const lines = source.split(/\r?\n/u);
  if (hasTrailingEol) lines.pop();

  const output: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (criticalProperty.test(line)) {
      if (!inserted) {
        output.push(...canonicalPropertyLines());
        inserted = true;
      }
      continue;
    }
    output.push(line);
  }

  if (!inserted) {
    const distributionBase = output.findIndex((line) =>
      /^\s*distributionBase(?:\s*[=:]\s*|\s+)/u.test(line),
    );
    output.splice(distributionBase + 1, 0, ...canonicalPropertyLines());
  }

  return `${output.join(eol)}${hasTrailingEol ? eol : ""}`;
}

export function validateAndroidGradleWrapper(source: string): string[] {
  const errors = mappingErrors();
  const values = new Map<string, string[]>();

  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(criticalProperty);
    if (!match?.[1]) continue;
    const entries = values.get(match[1]) ?? [];
    entries.push(match[2]?.trim() ?? "");
    values.set(match[1], entries);
  }

  const urls = values.get("distributionUrl") ?? [];
  const checksums = values.get("distributionSha256Sum") ?? [];

  if (urls.length === 0) {
    errors.push("The Gradle wrapper distribution URL is missing.");
  } else if (urls.length > 1) {
    errors.push("The Gradle wrapper distribution URL must occur exactly once.");
  } else if (urls[0] !== wrapperDistributionUrl()) {
    errors.push("The Gradle wrapper distribution URL/version does not match the canonical pin.");
  }

  if (checksums.length === 0) {
    errors.push("The Gradle wrapper distribution SHA-256 is missing.");
  } else if (checksums.length > 1) {
    errors.push("The Gradle wrapper distribution SHA-256 must occur exactly once.");
  } else if (!/^[0-9a-f]{64}$/u.test(checksums[0] ?? "")) {
    errors.push("The Gradle wrapper distribution SHA-256 is malformed.");
  } else if (checksums[0] !== androidGradleDistribution.distributionSha256Sum) {
    errors.push("The Gradle wrapper distribution SHA-256 does not match the canonical pin.");
  }

  return errors;
}
