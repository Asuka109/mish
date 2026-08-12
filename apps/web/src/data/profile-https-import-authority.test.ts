import { describe, expect, it } from "vitest";
import type { ProfilePreviewDto } from "@mish/contracts";
import { RpcSessionAuthority, type RpcSessionSnapshot } from "@mish/rpc-client";
import {
  PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS,
  ProfileHttpsImportAuthority,
  ProfileHttpsImportTranscriptOverflowError,
  ProfileHttpsImportTranscriptRecorder,
} from "./profile-https-import-authority";

const scope = { authorityId: "synthetic-profile-session", epoch: 1, order: 7 } as const;
const preview: ProfilePreviewDto = {
  classificationCounts: {
    applicationOverridden: 1,
    disabled: 0,
    platformOverridden: 0,
    preserved: 3,
    rejected: 0,
  },
  groupCount: 1,
  label: "synthetic-profile.yaml",
  previewId: "synthetic-https-preview-1",
  proxyCount: 2,
  ruleCount: 1,
  runtimeProvenance: {
    artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    authority: "desktop-policy",
    items: [],
    layers: [
      "source",
      "user-patches",
      "application-policy",
      "platform-integration",
      "effective-runtime",
    ],
    sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    unknownKeyCount: 0,
  },
  sensitiveDataNotice: "source-and-configuration-contain-sensitive-data",
  sourceType: "https",
  warningCodes: [],
};

interface Snapshot extends RpcSessionSnapshot {
  marker: string;
}

function connectedSession() {
  const session = new RpcSessionAuthority<Snapshot>();
  session.observeTransport(true);
  session.accept(
    session.beginSubscription(),
    { applicationOrder: scope, marker: "baseline" },
    "baseline",
  );
  return session;
}

function acceptedAuthority(
  authority: ProfileHttpsImportAuthority,
  nextScope = scope,
  nextPreview = preview,
) {
  const request = authority.beginPreview(nextScope);
  expect(request.kind).toBe("accepted");
  if (request.kind !== "accepted") throw new Error("synthetic HTTPS request was rejected");
  const accepted = authority.acceptPreview(request.request, nextPreview);
  expect(accepted.kind).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error("synthetic HTTPS preview was rejected");
  return { request: request.request, authority: accepted.authority };
}

describe("ProfileHttpsImportAuthority", () => {
  it("records only bounded semantic events for an accepted HTTPS preview and save", () => {
    const recorder = new ProfileHttpsImportTranscriptRecorder();
    const authority = new ProfileHttpsImportAuthority(connectedSession(), {
      trace: (event) => recorder.record(event),
    });
    const accepted = acceptedAuthority(authority);
    expect(
      authority.authorizeSave(scope, accepted.authority.preview, accepted.authority.generation),
    ).toMatchObject({
      kind: "accepted",
    });
    const transcript = recorder.snapshot();
    expect(transcript.schemaVersion).toBe(1);
    expect(transcript.events.map((event) => `${event.kind}:${event.phase}`)).toEqual([
      "preview:invocation",
      "preview:result",
      "save:invocation",
      "save:result",
    ]);
    expect(JSON.stringify(transcript)).not.toContain("https://profiles.example");
    expect(JSON.stringify(transcript)).not.toContain("not-a-real-password");
    expect(transcript.events.every((event) => event.generation === 1)).toBe(true);
  });

  it("accepts HTTPS only and consumes save authorization exactly once", () => {
    const authority = new ProfileHttpsImportAuthority(connectedSession());
    const request = authority.beginPreview(scope);
    expect(request.kind).toBe("accepted");
    if (request.kind !== "accepted") return;
    expect(
      authority.acceptPreview(request.request, { ...preview, sourceType: "local-file" }),
    ).toMatchObject({ kind: "unsupported-source", authority: null });

    const accepted = acceptedAuthority(authority);
    expect(authority.authorizeSave(scope, accepted.authority.preview, 1).kind).toBe("accepted");
    expect(authority.authorizeSave(scope, accepted.authority.preview, 1).kind).toBe("duplicate");
  });

  it("retires a replaced preview and rejects late completion from the old request", () => {
    const authority = new ProfileHttpsImportAuthority(connectedSession());
    const first = authority.beginPreview(scope);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    const secondScope = { ...scope, order: scope.order + 1 };
    const second = authority.beginPreview(secondScope);
    expect(second.kind).toBe("accepted");
    if (second.kind !== "accepted") return;

    expect(authority.acceptPreview(first.request, preview)).toMatchObject({
      kind: "stale",
      authority: null,
    });
    const secondPreview = { ...preview, previewId: "synthetic-https-preview-2" };
    expect(authority.acceptPreview(second.request, secondPreview)).toMatchObject({
      kind: "accepted",
    });
    expect(authority.authorizeSave(scope, secondPreview, 1)).toMatchObject({
      kind: "conflict",
      authority: null,
    });
    expect(authority.authorizeSave(secondScope, secondPreview, 1)).toMatchObject({ kind: "stale" });
  });

  it("rejects mismatched requests and session replacement at the authority boundary", () => {
    const session = connectedSession();
    const authority = new ProfileHttpsImportAuthority(session);
    const request = authority.beginPreview(scope);
    expect(request.kind).toBe("accepted");
    if (request.kind !== "accepted") return;
    expect(
      authority.acceptPreview({ ...request.request, extra: "unexpected" }, preview),
    ).toMatchObject({
      kind: "malformed",
      authority: null,
    });
    expect(authority.acceptPreview(request.request, preview)).toMatchObject({
      kind: "duplicate",
      authority: null,
    });

    const replacementRequest = authority.beginPreview(scope);
    expect(replacementRequest.kind).toBe("accepted");
    if (replacementRequest.kind !== "accepted") return;
    expect(
      authority.acceptPreview(
        { ...replacementRequest.request, scope: { ...scope, order: 9 } },
        preview,
      ),
    ).toMatchObject({ kind: "conflict", authority: null });

    const next = authority.beginPreview(scope);
    expect(next.kind).toBe("accepted");
    if (next.kind !== "accepted") return;
    session.observeTransport(false);
    session.observeTransport(true);
    session.accept(
      session.beginSubscription(),
      { applicationOrder: { ...scope, epoch: 2, order: 1 }, marker: "replacement" },
      "baseline",
    );
    expect(authority.acceptPreview(next.request, preview)).toMatchObject({
      kind: "stale",
      authority: null,
    });
  });

  it("bounds transcript storage and rejects malformed event shapes", () => {
    const recorder = new ProfileHttpsImportTranscriptRecorder(
      PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS,
    );
    const event = {
      generation: 1,
      kind: "preview" as const,
      phase: "invocation" as const,
      requestSequence: null,
      result: null,
      schemaVersion: 1 as const,
      sourceType: null,
    };
    for (let index = 0; index < PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS; index += 1) {
      recorder.record(event);
    }
    expect(() => recorder.record(event)).toThrow(ProfileHttpsImportTranscriptOverflowError);
    const malformed = new ProfileHttpsImportTranscriptRecorder();
    expect(() => malformed.record({ ...event, generation: -1 })).toThrow(TypeError);
  });
});
