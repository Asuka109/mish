import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type {
  ProfileRouteCatalogDto,
  ProfileSnapshotDto,
  StatusSnapshotDto,
} from "@mish/contracts";
import { useConfiguredRouteCatalog } from "./configured-route-catalog";
import { FixtureProfileClient } from "./fixture-profile-client";
import { FixtureStatusClient } from "./fixture-status-client";
import { ProfileProvider, useProfiles } from "./profile-provider";

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
    return {
      fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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

function ConfiguredRouteProbe({ snapshot }: { snapshot: StatusSnapshotDto }) {
  const catalog = useConfiguredRouteCatalog(snapshot);
  return <output data-testid="configured-route">{catalog?.profileId ?? "none"}</output>;
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

describe("ProfileProvider selected Profile authority", () => {
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

  it("invalidates the bounded configured-route cache by confirmed selection revision", async () => {
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
    client.confirm("work", 2);
    await waitFor(() => expect(client.routeRequests).toEqual(["work", "work"]));
    expect(screen.getByTestId("configured-route")).toHaveTextContent("work");
  });
});
