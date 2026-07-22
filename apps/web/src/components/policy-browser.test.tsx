import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BoundedEntityList, LatencyStatus } from "./policy-browser";

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

  it("renders historical zero milliseconds as unknown rather than measured success", () => {
    render(
      <LatencyStatus
        cancelledLabel="Cancelled"
        failureLabel={() => "Failed"}
        latencyMilliseconds={0}
        measuredLabel={(latency) => `${latency} ms`}
        testingLabel="Testing"
        unknownLabel="Unknown"
      />,
    );

    expect(screen.getByText("Unknown").closest("[data-latency-state]")).toHaveAttribute(
      "data-latency-state",
      "unknown",
    );
    expect(screen.queryByText("0 ms")).not.toBeInTheDocument();
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
        unknownLabel="Unknown"
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
        unknownLabel="Unknown"
      />,
    );
    expect(screen.getByText("Cancelled").closest("[data-latency-state]")).toHaveAttribute(
      "data-latency-state",
      "cancelled",
    );
  });
});
