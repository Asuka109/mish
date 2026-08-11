import { describe, expect, it } from "vitest";
import type { LocalBackupPreviewDto, LocalBackupScopeDto } from "@mish/contracts";
import { RpcSessionAuthority, type RpcSessionSnapshot } from "@mish/rpc-client";
import {
  LOCAL_BACKUP_EXPORT_TRANSCRIPT_MAX_EVENTS,
  LocalBackupExportAuthority,
  LocalBackupExportTranscriptOverflowError,
  LocalBackupExportTranscriptRecorder,
} from "./local-backup-authority";
import {
  canonicalLocalBackupExportJson,
  localBackupExportFingerprint,
} from "./local-backup-fingerprint";

const scope: LocalBackupScopeDto = {
  patches: true,
  profiles: false,
  schedules: true,
  settings: true,
  sourceLocators: false,
};

const preview: LocalBackupPreviewDto = {
  contentBytes: 4096,
  excludedSensitiveData: ["credentials-and-profile-contents", "subscription-urls-and-full-paths"],
  fileType: "application/json",
  formatVersion: 1,
  included: { patches: 2, profiles: 0, schedules: 1, settings: 1 },
  includedSensitiveData: [],
  maxBytes: 8 * 1_024 * 1_024,
  previewId: "synthetic-export-preview-1",
  scope,
};

interface Snapshot extends RpcSessionSnapshot {
  marker: string;
}

function connectedSession() {
  const session = new RpcSessionAuthority<Snapshot>();
  session.observeTransport(true);
  const ticket = session.beginSubscription();
  session.accept(
    ticket,
    {
      applicationOrder: { authorityId: "synthetic-backup-session", epoch: 1, order: 1 },
      marker: "baseline",
    },
    "baseline",
  );
  return session;
}

async function acceptedAuthority(
  authority: LocalBackupExportAuthority,
  selectedScope = scope,
  acceptedPreview = preview,
) {
  const request = await authority.beginPreview(selectedScope);
  expect(request.kind).toBe("accepted");
  if (request.kind !== "accepted") throw new Error("synthetic preview request was rejected");
  const result = await authority.acceptPreview(request.request, acceptedPreview);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("synthetic preview was rejected");
  return result.authority;
}

describe("local backup export fingerprint", () => {
  it("binds exact scope, preview content contract, and RPC generation deterministically", async () => {
    const first = await localBackupExportFingerprint(scope, preview, 1);
    const reordered = await localBackupExportFingerprint(
      { ...scope },
      {
        scope: { ...scope },
        previewId: preview.previewId,
        maxBytes: preview.maxBytes,
        contentBytes: preview.contentBytes,
        fileType: preview.fileType,
        formatVersion: preview.formatVersion,
        included: { ...preview.included },
        includedSensitiveData: [...preview.includedSensitiveData],
        excludedSensitiveData: [...preview.excludedSensitiveData],
      },
      1,
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(await localBackupExportFingerprint(scope, preview, 2)).not.toBe(first);
    expect(await localBackupExportFingerprint({ ...scope, settings: false }, preview, 1)).not.toBe(
      first,
    );
    expect(
      await localBackupExportFingerprint(scope, { ...preview, contentBytes: 4097 }, 1),
    ).not.toBe(first);
    expect(
      await localBackupExportFingerprint(
        scope,
        {
          ...preview,
          previewId: "synthetic-export-preview-changed",
        },
        1,
      ),
    ).not.toBe(first);
    expect(canonicalLocalBackupExportJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("LocalBackupExportAuthority", () => {
  it("records a bounded synthetic invocation/result transcript for a happy path", async () => {
    const recorder = new LocalBackupExportTranscriptRecorder();
    const authority = new LocalBackupExportAuthority(connectedSession(), {
      trace: (event) => recorder.record(event),
    });
    const accepted = await acceptedAuthority(authority);
    const saved = await authority.authorizeSave(scope, preview, accepted.generation);

    expect(saved.kind).toBe("accepted");
    const transcript = recorder.snapshot();
    expect(transcript.schemaVersion).toBe(1);
    expect(transcript.events.map((event) => `${event.kind}:${event.phase}`)).toEqual([
      "preview:invocation",
      "preview:result",
      "save:invocation",
      "save:result",
    ]);
    expect(JSON.stringify(transcript)).not.toContain("synthetic-backup-bytes");
    expect(JSON.stringify(transcript)).not.toContain("/Users/");
    expect(transcript.events.every((event) => event.generation === 1)).toBe(true);
  });

  it("invalidates the old authority when a new scope is explicitly previewed", async () => {
    const authority = new LocalBackupExportAuthority(connectedSession());
    const oldAuthority = await acceptedAuthority(authority);
    const nextScope = { ...scope, settings: false };
    const nextPreview = { ...preview, previewId: "synthetic-export-preview-2", scope: nextScope };
    await acceptedAuthority(authority, nextScope, nextPreview);

    await expect(
      authority.authorizeSave(scope, preview, oldAuthority.generation),
    ).resolves.toMatchObject({
      kind: "conflict",
      authority: null,
    });
    await expect(
      authority.authorizeSave(nextScope, nextPreview, oldAuthority.generation),
    ).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });
  });

  it("invalidates an old authority even when the replacement scope is malformed", async () => {
    const authority = new LocalBackupExportAuthority(connectedSession());
    const accepted = await acceptedAuthority(authority);
    await expect(
      authority.beginPreview({ ...scope, settings: false, patches: false, schedules: false }),
    ).resolves.toMatchObject({ kind: "malformed", request: null });
    await expect(
      authority.authorizeSave(scope, preview, accepted.generation),
    ).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });
  });

  it.each([
    ["malformed", { ...preview, included: {} }],
    [
      "conflicting",
      {
        ...preview,
        previewId: "synthetic-export-preview-conflict",
        scope: { ...scope, settings: false },
      },
    ],
  ] as const)("fails closed for %s preview acceptance", async (kind, candidate) => {
    const authority = new LocalBackupExportAuthority(connectedSession());
    const request = await authority.beginPreview(scope);
    expect(request.kind).toBe("accepted");
    if (request.kind !== "accepted") throw new Error("synthetic request rejected");
    await expect(authority.acceptPreview(request.request, candidate)).resolves.toMatchObject({
      kind: kind === "conflicting" ? "conflict" : kind,
      authority: null,
    });
    await expect(authority.authorizeSave(scope, preview, 1)).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });
  });

  it("fails closed for malformed or tampered preview requests", async () => {
    const malformedAuthority = new LocalBackupExportAuthority(connectedSession());
    const malformedRequest = await malformedAuthority.beginPreview(scope);
    expect(malformedRequest.kind).toBe("accepted");
    if (malformedRequest.kind !== "accepted") throw new Error("synthetic request rejected");
    await expect(
      malformedAuthority.acceptPreview(
        { ...malformedRequest.request, scope: undefined } as never,
        preview,
      ),
    ).resolves.toMatchObject({ kind: "malformed", authority: null });
    await expect(malformedAuthority.authorizeSave(scope, preview, 1)).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });

    const tamperedAuthority = new LocalBackupExportAuthority(connectedSession());
    const tamperedRequest = await tamperedAuthority.beginPreview(scope);
    expect(tamperedRequest.kind).toBe("accepted");
    if (tamperedRequest.kind !== "accepted") throw new Error("synthetic request rejected");
    await expect(
      tamperedAuthority.acceptPreview(
        { ...tamperedRequest.request, scopeFingerprint: "0".repeat(64) },
        preview,
      ),
    ).resolves.toMatchObject({ kind: "conflict", authority: null });
    await expect(tamperedAuthority.authorizeSave(scope, preview, 1)).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });
  });

  it("rejects duplicate preview acceptance and duplicate save authority use", async () => {
    const authority = new LocalBackupExportAuthority(connectedSession());
    const request = await authority.beginPreview(scope);
    expect(request.kind).toBe("accepted");
    if (request.kind !== "accepted") throw new Error("synthetic request rejected");
    await expect(authority.acceptPreview(request.request, preview)).resolves.toMatchObject({
      kind: "accepted",
    });
    await expect(authority.acceptPreview(request.request, preview)).resolves.toMatchObject({
      kind: "duplicate",
      authority: null,
    });

    const nextAuthority = await acceptedAuthority(authority);
    await expect(
      authority.authorizeSave(scope, preview, nextAuthority.generation),
    ).resolves.toMatchObject({
      kind: "accepted",
    });
    await expect(
      authority.authorizeSave(scope, preview, nextAuthority.generation),
    ).resolves.toMatchObject({
      kind: "duplicate",
      authority: null,
    });
  });

  it("rejects stale and wrong-generation acceptance after session replacement", async () => {
    const staleSession = connectedSession();
    const staleAuthority = new LocalBackupExportAuthority(staleSession);
    const staleAccepted = await acceptedAuthority(staleAuthority);
    staleSession.observeTransport(false);
    await expect(
      staleAuthority.authorizeSave(scope, preview, staleAccepted.generation),
    ).resolves.toMatchObject({
      kind: "stale",
      authority: null,
    });

    const replacementSession = connectedSession();
    const replacementAuthority = new LocalBackupExportAuthority(replacementSession);
    const accepted = await acceptedAuthority(replacementAuthority);
    replacementSession.observeTransport(false);
    replacementSession.observeTransport(true);
    const replacementTicket = replacementSession.beginSubscription();
    replacementSession.accept(
      replacementTicket,
      {
        applicationOrder: { authorityId: "synthetic-backup-replacement", epoch: 1, order: 1 },
        marker: "replacement",
      },
      "baseline",
    );
    expect(replacementSession.getGeneration()).toBe(2);
    expect(replacementSession.isStale()).toBe(false);
    await expect(
      replacementAuthority.authorizeSave(scope, preview, accepted.generation),
    ).resolves.toMatchObject({
      kind: "wrong-generation",
      authority: null,
    });
  });

  it("keeps transcript storage bounded and rejects overflow", () => {
    const recorder = new LocalBackupExportTranscriptRecorder(1);
    const event = {
      authorityFingerprint: null,
      generation: 1,
      kind: "preview" as const,
      phase: "invocation" as const,
      result: null,
      schemaVersion: 1 as const,
      scopeFingerprint: null,
    };
    recorder.record(event);
    expect(() => recorder.record(event)).toThrow(LocalBackupExportTranscriptOverflowError);
    const malformedRecorder = new LocalBackupExportTranscriptRecorder();
    expect(() =>
      malformedRecorder.record({
        ...event,
        phase: "result",
        result: "undeclared" as never,
      }),
    ).toThrow(TypeError);
    expect(LOCAL_BACKUP_EXPORT_TRANSCRIPT_MAX_EVENTS).toBe(32);
  });
});
