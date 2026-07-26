import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusClientError, type RoutingMode, type StatusSnapshotDto } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { FixtureStatusClient } from "./fixture-status-client";
import { ProductProvider, useProduct } from "./product-provider";

loadAllLocales();

class RuntimeReplacementClient extends FixtureStatusClient {
  snapshotRequests = 0;

  override async getSnapshot(options?: { signal?: AbortSignal }) {
    this.snapshotRequests += 1;
    return super.getSnapshot(options);
  }

  override async setRoutingMode(
    _mode: RoutingMode,
    _options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    const snapshot = await super.getSnapshot();
    snapshot.activeProfileId = "profile-replacement";
    snapshot.profiles = [{ id: "profile-replacement", label: "Replacement profile" }];
    snapshot.routingMode = "rule";
    throw new StatusClientError(
      "runtime-replaced",
      "The Status runtime was replaced before the command completed",
      true,
      snapshot,
    );
  }
}

function RuntimeReplacementHarness() {
  const { setRoutingMode, snapshot } = useProduct();
  return (
    <>
      <button onClick={() => void setRoutingMode("global")} type="button">
        Change routing
      </button>
      <output data-testid="profile">{snapshot?.activeProfileId ?? "loading"}</output>
      <output data-testid="routing">{snapshot?.routingMode ?? "loading"}</output>
    </>
  );
}

describe("ProductProvider runtime replacement reconciliation", () => {
  it("applies the authoritative terminal snapshot without issuing a second refresh", async () => {
    const client = new RuntimeReplacementClient();
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={client}>
          <RuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("home"));
    expect(client.snapshotRequests).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Change routing" }));

    await waitFor(() => {
      expect(screen.getByTestId("profile")).toHaveTextContent("profile-replacement");
      expect(screen.getByTestId("routing")).toHaveTextContent("rule");
    });
    expect(client.snapshotRequests).toBe(1);
  });
});
