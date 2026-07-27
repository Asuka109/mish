import {
  applicationEventKindSchema,
  EventRecordSchema,
  type ApplicationEvent,
  type ApplicationEventDataByKind,
  type ApplicationEventKind,
  type EventRecordDto,
} from "@mish/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { i18nObject } from "../i18n/i18n-util";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { presentEvent } from "./event-presentation";

beforeAll(loadAllLocales);

const sampleData = {
  "capture.failure": { failure: "core-unhealthy", observationStage: "capture-change" },
  "controller.session-started": {},
  "controller.session-stale": {},
  "controller.stream-unavailable": { failure: "handshake-failed" },
  "profile.activation-failed": { failure: "missing-binary" },
  "proxy.launch-timing": {
    listenerJournalMutationConfirmationMs: 2,
    outcome: "ready",
    overlapMs: 1,
    preparationWallMs: 3,
    profileCoreMs: 4,
    schemaVersion: 1,
    systemProxyPreflightMs: 5,
    totalMs: 15,
  },
  "settings.operation-failed": { failure: "persistence" },
  "traffic.operation-failed": { failure: "timeout" },
} satisfies ApplicationEventDataByKind;

function applicationEvent<K extends ApplicationEventKind>(
  kind: K,
  data: ApplicationEventDataByKind[K],
): EventRecordDto {
  return {
    application: { actionIds: [], data, kind } as ApplicationEvent,
    evidence: null,
    id: `session:7:${kind}`,
    level: "error",
    observedAt: 7,
    sequence: 7,
    source: "application",
  };
}

describe("application event presentation", () => {
  it("exhaustively presents every generated event kind in every Web locale", () => {
    for (const locale of ["en", "zh"] as const) {
      const LL = i18nObject(locale);
      for (const kind of applicationEventKindSchema.options) {
        const presented = presentEvent(applicationEvent(kind, sampleData[kind]), LL);
        expect(presented.message).toBeTruthy();
        expect(presented.detail).toBeTruthy();
      }
    }
  });

  it("re-localizes retained history without changing identity, order, or actions", () => {
    const retained = [
      applicationEvent("capture.failure", sampleData["capture.failure"]),
      applicationEvent("traffic.operation-failed", sampleData["traffic.operation-failed"]),
    ];
    const english = retained.map((event) => presentEvent(event, i18nObject("en")));
    const chinese = retained.map((event) => presentEvent(event, i18nObject("zh")));

    expect(chinese.map(({ id, sequence }) => ({ id, sequence }))).toEqual(
      english.map(({ id, sequence }) => ({ id, sequence })),
    );
    expect(chinese.map(({ actionIds }) => actionIds)).toEqual(
      english.map(({ actionIds }) => actionIds),
    );
    expect(chinese.map(({ message }) => message)).not.toEqual(
      english.map(({ message }) => message),
    );
  });

  it("rejects legacy copy fields, missing typed data, and invalid action IDs", () => {
    const identity = {
      id: "session:1",
      level: "error",
      observedAt: 1,
      sequence: 1,
      source: "application",
    };
    expect(
      EventRecordSchema.safeParse({
        ...identity,
        detail: "legacy detail",
        message: "legacy message",
      }).success,
    ).toBe(false);
    expect(
      EventRecordSchema.safeParse({
        ...identity,
        application: {
          actionIds: ["retry-profile-activation"],
          data: {},
          kind: "capture.failure",
        },
        evidence: null,
      }).success,
    ).toBe(false);
    expect(
      EventRecordSchema.safeParse({
        ...identity,
        application: {
          actionIds: ["repair"],
          data: { failure: "core-unhealthy" },
          kind: "capture.failure",
        },
        evidence: null,
      }).success,
    ).toBe(false);
  });
});
