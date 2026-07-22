import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BoundedEntityList, LatencyStatus, PolicyEntityRow } from "./policy-browser";

describe("policy browser primitives", () => {
  it("mounts direct children in 100-row batches and announces the preserved expansion", async () => {
    const user = userEvent.setup();
    const ids = Array.from({ length: 260 }, (_, index) => `node-${index + 1}`);
    render(
      <BoundedEntityList
        empty={<p>Empty</p>}
        ids={ids}
        loadedAnnouncement={(added, total) => `${added} added, ${total} total`}
        showMoreLabel={(remaining) => `Show ${Math.min(100, remaining)} more`}
      >
        {(visibleIds) =>
          visibleIds.map((id) => (
            <li key={id}>
              <button data-policy-row-primary type="button">
                {id}
              </button>
            </li>
          ))
        }
      </BoundedEntityList>,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    expect(screen.queryByText("node-260")).not.toBeInTheDocument();
    const showMore = screen.getByRole("button", { name: "Show 100 more" });
    showMore.focus();
    await user.click(showMore);
    expect(screen.getAllByRole("listitem")).toHaveLength(200);
    expect(screen.getByText("node-200")).toBeVisible();
    expect(screen.queryByText("node-201")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("100 added, 200 total");
    expect(showMore).toHaveFocus();
  });

  it("moves focus among peer rows with Arrow, Home, and End", async () => {
    const user = userEvent.setup();
    render(
      <BoundedEntityList
        empty={<p>Empty</p>}
        ids={["one", "two", "three"]}
        loadedAnnouncement={() => ""}
        showMoreLabel={() => ""}
      >
        {(visibleIds) =>
          visibleIds.map((id) => (
            <li key={id}>
              <button data-policy-row-primary type="button">
                {id}
              </button>
            </li>
          ))
        }
      </BoundedEntityList>,
    );

    const one = screen.getByRole("button", { name: "one" });
    const two = screen.getByRole("button", { name: "two" });
    const three = screen.getByRole("button", { name: "three" });
    one.focus();
    await user.keyboard("{ArrowDown}");
    expect(two).toHaveFocus();
    await user.keyboard("{End}");
    expect(three).toHaveFocus();
    await user.keyboard("{Home}");
    expect(one).toHaveFocus();
  });

  it("uses an automatic-selection badge and dims a static group when commands are unavailable", () => {
    render(
      <PolicyEntityRow
        automaticLabel="Auto-select"
        currentLabel="Selected"
        disabled
        entity={{
          childIds: ["sg-node"],
          id: "sg-auto",
          label: "SG Singapore",
          selectedChildId: "sg-node",
          type: "url-test",
        }}
        entityKind="group"
        latency={<span>Unknown</span>}
        metadata="Policy group · url-test"
        muted
        pendingLabel="Switching"
        readOnlyLabel="Read-only"
        selected={false}
        selectionPending={false}
      />,
    );

    const row = screen.getByText("SG Singapore").closest("[data-entity-id]");
    expect(row).toHaveAttribute("data-disabled", "true");
    expect(row).toHaveAttribute("data-muted", "true");
    expect(row).toHaveClass("opacity-55");
    expect(screen.getByText("Auto-select")).toBeVisible();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("uses one neutral treatment for unavailable current and automatic rows", () => {
    const { container } = render(
      <>
        <PolicyEntityRow
          currentLabel="Selected"
          disabled
          entity={{
            id: "current-node",
            label: "Current node",
            latencyMilliseconds: 42,
            protocol: "ss",
          }}
          entityKind="node"
          latency={
            <LatencyStatus
              cancelledLabel="Cancelled"
              failureLabel={() => "Failed"}
              latencyMilliseconds={42}
              measuredLabel={(value) => `${value} ms`}
              testingLabel="Testing"
            />
          }
          metadata="ss"
          muted
          onSelect={() => undefined}
          pendingLabel="Switching"
          readOnlyLabel="Read-only"
          selectLabel="Select Current node"
          selected
          selectionPending={false}
        />
        <PolicyEntityRow
          automaticLabel="Auto-select"
          currentLabel="Selected"
          disabled
          entity={{
            childIds: ["current-node"],
            id: "automatic-group",
            label: "Automatic group",
            selectedChildId: "current-node",
            type: "url-test",
          }}
          entityKind="group"
          latency={<span>Unknown</span>}
          metadata="Policy group · url-test"
          muted
          pendingLabel="Switching"
          readOnlyLabel="Read-only"
          selected={false}
          selectionPending={false}
        />
      </>,
    );

    const rows = [...container.querySelectorAll<HTMLElement>("[data-entity-id]")];
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row).toHaveClass("opacity-55");
      expect(row).not.toHaveClass("bg-accent");
    });
    expect(screen.getByRole("button", { name: "Select Current node" })).toBeDisabled();
    expect(screen.getByText("Selected")).toHaveClass("text-success-text");
    const currentStatus = rows[0]!.querySelector(".policy-browser-entity-status");
    expect(currentStatus?.children[0]).toHaveClass("policy-browser-selection");
    expect(currentStatus?.children[1]).toHaveClass("policy-browser-latency");
  });

  it("hides unavailable and historical zero latency instead of presenting them as results", () => {
    const { container, rerender } = render(
      <LatencyStatus
        cancelledLabel="Cancelled"
        failureLabel={() => "Failed"}
        latencyMilliseconds={0}
        measuredLabel={(latency) => `${latency} ms`}
        testingLabel="Testing"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("0 ms")).not.toBeInTheDocument();

    rerender(
      <LatencyStatus
        cancelledLabel="Cancelled"
        failureLabel={() => "Failed"}
        latencyMilliseconds={null}
        measuredLabel={(latency) => `${latency} ms`}
        testingLabel="Testing"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders typed failure and cancellation states with observation time", () => {
    const { container, rerender } = render(
      <LatencyStatus
        cancelledLabel="Cancelled"
        failureLabel={(result) => (result.failure === "disconnected" ? "Disconnected" : "Failed")}
        measuredLabel={(latency) => `${latency} ms`}
        result={{
          childId: "node",
          failure: "disconnected",
          latencyMilliseconds: null,
          observedAt: 1_720_000_000_000,
          phase: "failed",
        }}
        testingLabel="Testing"
      />,
    );

    expect(screen.getByText("Disconnected").closest("[data-latency-state]")).toHaveAttribute(
      "data-latency-state",
      "failed",
    );
    expect(container.querySelector("time")).toHaveAttribute("datetime");

    rerender(
      <LatencyStatus
        cancelledLabel="Cancelled"
        failureLabel={() => "Failed"}
        measuredLabel={(latency) => `${latency} ms`}
        result={{
          childId: "node",
          failure: "cancelled",
          latencyMilliseconds: null,
          observedAt: 1_720_000_000_100,
          phase: "cancelled",
        }}
        testingLabel="Testing"
      />,
    );
    expect(screen.getByText("Cancelled").closest("[data-latency-state]")).toHaveAttribute(
      "data-latency-state",
      "cancelled",
    );
  });
});
