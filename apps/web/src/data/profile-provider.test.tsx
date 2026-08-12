import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type {
  ApplicationSnapshotDelivery,
  ProfileRouteCatalogDto,
  ProfileSnapshotDto,
  StatusConnectionState,
  StatusSnapshotDto,
} from "@mish/contracts";
import { ProfileClientError } from "@mish/contracts";
import { useConfiguredRouteCatalog } from "./configured-route-catalog";
import { FixtureProfileClient } from "./fixture-profile-client";
import { FixtureStatusClient } from "./fixture-status-client";
import { ProfileProvider, useProfiles } from "./profile-provider";

const confirmedStatusConnection = {
  attempt: 0,
  phase: "fixture",
  stale: false,
} satisfies StatusConnectionState;

class SelectionRaceClient extends FixtureProfileClient {
  private readonly listeners = new Set<(snapshot: ProfileSnapshotDto) => void>();
  private pending:
    | {
        resolve(snapshot: ProfileSnapshotDto): void;
      }
    | undefined;
  private snapshotState!: ProfileSnapshotDto;
  readonly routeRequests: string[] = [];

  async initialize() {
    this.snapshotState = await super.getSnapshot();
    this.snapshotState.profiles.push({
      ...structuredClone(this.snapshotState.profiles[0]),
      id: "fixture-profile-travel",
      label: "Travel route set",
      status: { ...this.snapshotState.profiles[0].status, active: false },
    });
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override selectProfile(): Promise<ProfileSnapshotDto> {
    return new Promise((resolve) => {
      this.pending = { resolve };
    });
  }

  override async getRoutes(profileId: string): Promise<ProfileRouteCatalogDto> {
    this.routeRequests.push(profileId);
    const fingerprint = this.snapshotState.profiles.find(
      (profile) => profile.id === profileId,
    )?.effectiveFingerprint;
    if (!fingerprint) throw new Error("Unknown Profile route request");
    return {
      fingerprint,
      groups: [],
      nodes: [],
      profileId,
      routingMode: "rule",
    };
  }

  override subscribeSnapshots(listener: (snapshot: ProfileSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  confirm(profileId: string, revision: number) {
    this.snapshotState.selection = { profileId, revision };
    this.snapshotState.applicationOrder.order = revision;
    const snapshot = structuredClone(this.snapshotState);
    for (const listener of this.listeners) listener(snapshot);
  }

  confirmSemanticRevision(fingerprint: string, order: number) {
    const selectedProfile = this.snapshotState.profiles.find(
      (profile) => profile.id === this.snapshotState.selection.profileId,
    );
    if (!selectedProfile) throw new Error("No selected Profile");
    selectedProfile.effectiveFingerprint = fingerprint;
    selectedProfile.runtimeProvenance.artifactFingerprint = fingerprint;
    this.snapshotState.applicationOrder.order = order;
    const snapshot = structuredClone(this.snapshotState);
    for (const listener of this.listeners) listener(snapshot);
  }

  resolvePending(profileId: string, revision: number) {
    const pending = this.pending;
    if (!pending) throw new Error("No pending Profile selection");
    this.pending = undefined;
    pending.resolve({
      ...structuredClone(this.snapshotState),
      applicationOrder: {
        ...this.snapshotState.applicationOrder,
        order: revision,
      },
      selection: { profileId, revision },
    });
  }
}

class FirstProfileClient extends FixtureProfileClient {
  private readonly listeners = new Set<
    (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private snapshotState: ProfileSnapshotDto;
  readonly routeRequests: string[] = [];

  constructor(snapshot: ProfileSnapshotDto) {
    super();
    this.snapshotState = structuredClone(snapshot);
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override async savePreview(): Promise<ProfileSnapshotDto> {
    const template = (await super.getSnapshot()).profiles[0];
    this.snapshotState = {
      ...this.snapshotState,
      applicationOrder: {
        ...this.snapshotState.applicationOrder,
        order: this.snapshotState.applicationOrder.order + 1,
      },
      profiles: [template],
      selection: { profileId: template.id, revision: 1 },
    };
    const snapshot = structuredClone(this.snapshotState);
    for (const listener of this.listeners) listener(snapshot, "update");
    return snapshot;
  }

  override async getRoutes(profileId: string): Promise<ProfileRouteCatalogDto> {
    this.routeRequests.push(profileId);
    return {
      fingerprint: this.snapshotState.profiles[0].effectiveFingerprint,
      groups: [
        {
          childIds: ["first-node"],
          id: "first-group",
          label: "First configured group",
          selectedChildId: "first-node",
          type: "selector",
        },
      ],
      nodes: [
        {
          id: "first-node",
          label: "First configured node",
          latencyMilliseconds: null,
          protocol: "ss",
        },
      ],
      profileId,
      routingMode: "rule",
    };
  }

  override subscribeSnapshots(
    listener: (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

interface DeferredRouteRequest {
  profileId: string;
  reject(error: unknown): void;
  resolve(catalog: ProfileRouteCatalogDto): void;
  signal: AbortSignal | undefined;
}

class DeferredAuthorityClient extends FixtureProfileClient {
  private readonly listeners = new Set<
    (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private snapshotState: ProfileSnapshotDto;
  readonly routeRequests: DeferredRouteRequest[] = [];

  constructor(snapshot: ProfileSnapshotDto) {
    super();
    this.snapshotState = structuredClone(snapshot);
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override getRoutes(
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileRouteCatalogDto> {
    return new Promise((resolve, reject) => {
      this.routeRequests.push({ profileId, reject, resolve, signal: options?.signal });
    });
  }

  override subscribeSnapshots(
    listener: (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitSemanticRevision(fingerprint: string, order: number) {
    const selected = this.snapshotState.profiles.find(
      (profile) => profile.id === this.snapshotState.selection.profileId,
    );
    if (!selected) throw new Error("No selected Profile");
    selected.effectiveFingerprint = fingerprint;
    selected.runtimeProvenance.artifactFingerprint = fingerprint;
    this.snapshotState.applicationOrder.order = order;
    this.emit(this.snapshotState);
  }

  emitDeletion(order: number) {
    this.snapshotState = {
      ...this.snapshotState,
      applicationOrder: { ...this.snapshotState.applicationOrder, order },
      profiles: [],
      selection: {
        profileId: null,
        revision: this.snapshotState.selection.revision + 1,
      },
    };
    this.emit(this.snapshotState);
  }

  emit(snapshot: ProfileSnapshotDto) {
    const delivery = structuredClone(snapshot);
    for (const listener of this.listeners) listener(delivery, "update");
  }
}

interface PendingDetach {
  reject(error: unknown): void;
  resolve(snapshot: ProfileSnapshotDto): void;
  signal: AbortSignal | undefined;
}

class DetachRaceClient extends FixtureProfileClient {
  private readonly listeners = new Set<
    (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private snapshotState: ProfileSnapshotDto;
  pendingDetach: PendingDetach | null = null;

  constructor(snapshot: ProfileSnapshotDto) {
    super();
    this.snapshotState = structuredClone(snapshot);
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override detachSubscription(
    _profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto> {
    return new Promise((resolve, reject) => {
      this.pendingDetach = { reject, resolve, signal: options?.signal };
    });
  }

  override subscribeSnapshots(
    listener: (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: ProfileSnapshotDto, delivery: ApplicationSnapshotDelivery = "update") {
    this.snapshotState = structuredClone(snapshot);
    for (const listener of this.listeners) listener(structuredClone(snapshot), delivery);
  }

  rejectDetach(message = "The subscription could not be detached") {
    const pending = this.pendingDetach;
    this.pendingDetach = null;
    pending?.reject(new ProfileClientError("remote", message));
  }

  resolveDetach(snapshot: ProfileSnapshotDto) {
    const pending = this.pendingDetach;
    this.pendingDetach = null;
    pending?.resolve(structuredClone(snapshot));
  }
}

function routeCatalog(
  profileId: string,
  fingerprint: string,
  label: string,
): ProfileRouteCatalogDto {
  return {
    fingerprint,
    groups: [
      {
        childIds: [`${label}-node`],
        id: `${label}-group`,
        label,
        selectedChildId: `${label}-node`,
        type: "selector",
      },
    ],
    nodes: [
      {
        id: `${label}-node`,
        label: `${label} node`,
        latencyMilliseconds: null,
        protocol: "ss",
      },
    ],
    profileId,
    routingMode: "rule",
  };
}

function ConfiguredRouteProbe({ snapshot }: { snapshot: StatusSnapshotDto }) {
  const catalog = useConfiguredRouteCatalog(snapshot, confirmedStatusConnection);
  return <output data-testid="configured-route">{catalog?.profileId ?? "none"}</output>;
}

function SelectionAndConfiguredRouteProbe({ snapshot }: { snapshot: StatusSnapshotDto }) {
  const profiles = useProfiles();
  const catalog = useConfiguredRouteCatalog(snapshot, confirmedStatusConnection);
  return (
    <>
      <output data-testid="configured-route">{catalog?.profileId ?? "none"}</output>
      <button onClick={() => void profiles.selectProfile("home")} type="button">
        Select Home
      </button>
    </>
  );
}

function SelectionProbe() {
  const profiles = useProfiles();
  const [result, setResult] = useState("idle");
  return (
    <>
      <output data-testid="selection">
        {profiles.selectedProfileId}:{profiles.selectedProfileRevision}
      </output>
      <output data-testid="result">{result}</output>
      <button
        onClick={() => {
          void profiles.selectProfile("home").then((next) => {
            setResult(next.ok ? "success" : "failure");
          });
        }}
        type="button"
      >
        Select Home
      </button>
    </>
  );
}

function FirstProfileProbe({ snapshot }: { snapshot: StatusSnapshotDto }) {
  const profiles = useProfiles();
  const catalog = useConfiguredRouteCatalog(snapshot, confirmedStatusConnection);
  return (
    <>
      <output data-testid="first-profile-selection">{profiles.selectedProfileId ?? "none"}</output>
      <output data-testid="first-profile-routes">{catalog?.groups[0]?.label ?? "none"}</output>
      <button onClick={() => void profiles.savePreview("first-preview")} type="button">
        Save first Profile
      </button>
    </>
  );
}

function ConfiguredRouteLabelProbe({
  connection = confirmedStatusConnection,
  snapshot,
}: {
  connection?: StatusConnectionState;
  snapshot: StatusSnapshotDto;
}) {
  const catalog = useConfiguredRouteCatalog(snapshot, connection);
  return (
    <output data-testid="configured-route-label">{catalog?.groups[0]?.label ?? "none"}</output>
  );
}

function DetachProbe() {
  const profiles = useProfiles();
  const [result, setResult] = useState("idle");
  return (
    <>
      <output data-testid="detach-source">
        {profiles.snapshot?.profiles[0]?.source.display ?? "none"}
      </output>
      <output data-testid="detach-result">{result}</output>
      <button
        onClick={() => {
          void profiles.detachSubscription("work").then((next) => {
            setResult(next.ok ? "success" : next.error.code);
          });
        }}
        type="button"
      >
        Detach Profile
      </button>
    </>
  );
}

describe("ProfileProvider selected Profile authority", () => {
  it("loads configured routes when saving the first Profile publishes auto-selection", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    initial.applicationOrder.order = 1;
    initial.profiles = [];
    initial.selection = { profileId: null, revision: 0 };
    const client = new FirstProfileClient(initial);
    const status = await new FixtureStatusClient().getSnapshot();
    status.groups = [];
    status.nodes = [];
    status.runtime.phase = "inactive";
    render(
      <ProfileProvider client={client}>
        <FirstProfileProbe snapshot={status} />
      </ProfileProvider>,
    );

    expect(await screen.findByTestId("first-profile-selection")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "Save first Profile" }));

    expect(await screen.findByTestId("first-profile-selection")).toHaveTextContent("work");
    await waitFor(() =>
      expect(screen.getByTestId("first-profile-routes")).toHaveTextContent(
        "First configured group",
      ),
    );
    expect(client.routeRequests).toEqual(["work"]);
  });

  it("lets a newer confirmed revision supersede optimism and rejects a delayed stale result", async () => {
    localStorage.removeItem("mish.selected-profile-id");
    const client = new SelectionRaceClient();
    await client.initialize();
    const rendered = render(
      <ProfileProvider client={client}>
        <SelectionProbe />
      </ProfileProvider>,
    );

    expect(await screen.findByTestId("selection")).toHaveTextContent("work:1");
    fireEvent.click(screen.getByRole("button", { name: "Select Home" }));
    expect(screen.getByTestId("selection")).toHaveTextContent("home:1");

    client.confirm("fixture-profile-travel", 3);
    expect(await screen.findByTestId("selection")).toHaveTextContent("fixture-profile-travel:3");
    client.resolvePending("home", 2);

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("failure"));
    expect(screen.getByTestId("selection")).toHaveTextContent("fixture-profile-travel:3");
    expect(localStorage.getItem("mish.selected-profile-id")).toBeNull();

    rendered.unmount();
    render(
      <ProfileProvider client={client}>
        <SelectionProbe />
      </ProfileProvider>,
    );
    expect(await screen.findByTestId("selection")).toHaveTextContent("fixture-profile-travel:3");
  });

  it("invalidates the configured-route cache by the selected Profile semantic revision", async () => {
    const client = new SelectionRaceClient();
    await client.initialize();
    const status = await new FixtureStatusClient().getSnapshot();
    status.groups = [];
    status.nodes = [];
    status.runtime.phase = "inactive";
    render(
      <ProfileProvider client={client}>
        <ConfiguredRouteProbe snapshot={status} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("configured-route")).toHaveTextContent("work"));
    client.confirmSemanticRevision(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      2,
    );
    await waitFor(() => expect(client.routeRequests).toEqual(["work", "work"]));
    expect(screen.getByTestId("configured-route")).toHaveTextContent("work");
  });

  it("does not derive configured routes from an unconfirmed selection projection", async () => {
    const client = new SelectionRaceClient();
    await client.initialize();
    const status = await new FixtureStatusClient().getSnapshot();
    status.groups = [];
    status.nodes = [];
    status.runtime.phase = "inactive";
    render(
      <ProfileProvider client={client}>
        <SelectionAndConfiguredRouteProbe snapshot={status} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(client.routeRequests).toEqual(["work"]));
    fireEvent.click(screen.getByRole("button", { name: "Select Home" }));
    await waitFor(() => expect(screen.getByTestId("configured-route")).toHaveTextContent("work"));
    expect(client.routeRequests).toEqual(["work"]);
  });

  it("cancels superseded route loads and rejects delayed catalogs across revision and deletion", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    const client = new DeferredAuthorityClient(initial);
    const status = await new FixtureStatusClient().getSnapshot();
    status.groups = [];
    status.nodes = [];
    status.runtime.phase = "inactive";
    render(
      <ProfileProvider client={client}>
        <ConfiguredRouteLabelProbe snapshot={status} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(client.routeRequests).toHaveLength(1));
    const first = client.routeRequests[0];
    const firstSnapshot = structuredClone(initial);
    const nextFingerprint = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    client.emitSemanticRevision(nextFingerprint, 2);

    await waitFor(() => expect(client.routeRequests).toHaveLength(2));
    expect(first.signal?.aborted).toBe(true);
    const second = client.routeRequests[1];
    second.resolve(routeCatalog(second.profileId, nextFingerprint, "New routes"));
    await waitFor(() =>
      expect(screen.getByTestId("configured-route-label")).toHaveTextContent("New routes"),
    );

    first.resolve(
      routeCatalog(first.profileId, initial.profiles[0].effectiveFingerprint, "Delayed old routes"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("configured-route-label")).toHaveTextContent("New routes"),
    );

    const failedFingerprint = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    client.emitSemanticRevision(failedFingerprint, 3);
    await waitFor(() => expect(client.routeRequests).toHaveLength(3));
    expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none");
    client.routeRequests[2].reject(new Error("Configured routes unavailable"));
    await waitFor(() =>
      expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none"),
    );

    client.emitDeletion(4);
    await waitFor(() =>
      expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none"),
    );
    firstSnapshot.applicationOrder.order = 2;
    client.emit(firstSnapshot);
    expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none");
  });

  it("clears configured routes while Status authority is stale or live", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    const client = new DeferredAuthorityClient(initial);
    const status = await new FixtureStatusClient().getSnapshot();
    status.groups = [];
    status.nodes = [];
    status.runtime.phase = "inactive";
    const rendered = render(
      <ProfileProvider client={client}>
        <ConfiguredRouteLabelProbe snapshot={status} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(client.routeRequests).toHaveLength(1));
    const first = client.routeRequests[0];
    first.resolve(
      routeCatalog(first.profileId, initial.profiles[0].effectiveFingerprint, "Confirmed routes"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("configured-route-label")).toHaveTextContent("Confirmed routes"),
    );

    rendered.rerender(
      <ProfileProvider client={client}>
        <ConfiguredRouteLabelProbe
          connection={{ attempt: 1, phase: "reconnecting", stale: true }}
          snapshot={status}
        />
      </ProfileProvider>,
    );
    expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none");

    const liveStatus = structuredClone(status);
    liveStatus.runtime.phase = "healthy";
    rendered.rerender(
      <ProfileProvider client={client}>
        <ConfiguredRouteLabelProbe snapshot={liveStatus} />
      </ProfileProvider>,
    );
    expect(screen.getByTestId("configured-route-label")).toHaveTextContent("none");
  });

  it("cancels a replaced detach authority and ignores the late completion", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    const client = new DetachRaceClient(initial);
    render(
      <ProfileProvider client={client}>
        <DetachProbe />
      </ProfileProvider>,
    );

    expect(await screen.findByTestId("detach-source")).toHaveTextContent(
      "https://profiles.example/…",
    );
    fireEvent.click(screen.getByRole("button", { name: "Detach Profile" }));
    await waitFor(() => expect(client.pendingDetach).not.toBeNull());

    const replacement = structuredClone(initial);
    replacement.applicationOrder.order += 1;
    client.emit(replacement);
    expect(client.pendingDetach?.signal?.aborted).toBe(true);
    client.resolveDetach(initial);

    await waitFor(() => expect(screen.getByTestId("detach-result")).toHaveTextContent("cancelled"));
    expect(screen.getByTestId("detach-source")).toHaveTextContent("https://profiles.example/…");
  });

  it("keeps detach failure evidence bounded and leaves the public snapshot redacted", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    const client = new DetachRaceClient(initial);
    const syntheticMarker = "synthetic-subscription-token";
    render(
      <ProfileProvider client={client}>
        <DetachProbe />
      </ProfileProvider>,
    );

    await screen.findByTestId("detach-source");
    const unsafe = structuredClone(initial);
    unsafe.profiles[0].source = {
      display: `https://profiles.example/config.yaml?token=${syntheticMarker}`,
      sourceType: "https",
    };
    client.emit(unsafe);
    await waitFor(() =>
      expect(screen.getByTestId("detach-source")).toHaveTextContent("https://profiles.example/…"),
    );
    expect(document.body).not.toHaveTextContent(syntheticMarker);

    fireEvent.click(screen.getByRole("button", { name: "Detach Profile" }));
    await waitFor(() => expect(client.pendingDetach).not.toBeNull());
    client.rejectDetach("The subscription could not be detached");

    await waitFor(() => expect(screen.getByTestId("detach-result")).toHaveTextContent("remote"));
    expect(document.body).not.toHaveTextContent(syntheticMarker);
    expect(screen.getByTestId("detach-source")).toHaveTextContent("https://profiles.example/…");
  });

  it("does not publish a late detach completion after the provider remounts", async () => {
    const initial = await new FixtureProfileClient().getSnapshot();
    const client = new DetachRaceClient(initial);
    const rendered = render(
      <ProfileProvider client={client}>
        <DetachProbe />
      </ProfileProvider>,
    );

    await screen.findByTestId("detach-source");
    fireEvent.click(screen.getByRole("button", { name: "Detach Profile" }));
    await waitFor(() => expect(client.pendingDetach).not.toBeNull());
    rendered.unmount();
    client.resolveDetach(initial);
    expect(document.body).not.toHaveTextContent("synthetic-subscription-token");
  });
});
