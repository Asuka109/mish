import { useMemo, useState, type ReactNode } from "react";
import type { OrpcEventData, OrpcSettingsData, OrpcStatusData } from "@mish/contracts";
import { useCutoverView } from "../data/cutover-view-facade";

function Page({
  eyebrow,
  title,
  description,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-5" data-product-page={title.toLowerCase()}>
      <header>
        <p className="text-metadata uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-1 text-display font-semibold tracking-title-tight">{title}</h2>
        <p className="mt-2 max-w-3xl text-body leading-6 text-muted-foreground">{description}</p>
      </header>
      {children}
    </div>
  );
}

function Card({
  title,
  value,
  detail,
}: {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <section className="rounded-lg border border-hairline-soft bg-surface-soft p-4">
      <p className="text-metadata text-muted-foreground">{title}</p>
      <p className="mt-2 text-heading font-medium" data-card-value={title.toLowerCase()}>
        {value}
      </p>
      <p className="mt-1 text-caption text-muted-foreground">{detail}</p>
    </section>
  );
}

function LoadingPanel({ label }: { readonly label: string }) {
  return (
    <section
      className="rounded-lg border border-hairline-soft bg-surface-soft p-5"
      aria-live="polite"
    >
      <p className="text-body text-muted-foreground">
        Waiting for the {label} projection from the admitted oRPC session.
      </p>
    </section>
  );
}

function StatusContent({ data }: { readonly data: OrpcStatusData | undefined }) {
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  if (!data) return <LoadingPanel label="status" />;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card detail="oRPC session projection" title="Phase" value={data.phase} />
        <Card
          detail="Current selected profile"
          title="Profile"
          value={data.profileName ?? "None"}
        />
        <Card
          detail="Observed active sessions"
          title="Connections"
          value={String(data.activeConnections)}
        />
      </div>
      <section className="rounded-lg border border-hairline-soft bg-surface-soft p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-heading font-semibold">Runtime overview</h3>
            <p className="mt-1 text-caption text-muted-foreground">
              Read-only values are owned by Query; tabs are local presentation state.
            </p>
          </div>
          <div
            className="flex rounded-md border border-hairline-soft p-1"
            role="tablist"
            aria-label="Status view"
          >
            {(["overview", "activity"] as const).map((value) => (
              <button
                className={`rounded px-3 py-1.5 text-metadata ${tab === value ? "bg-accent text-ink" : "text-muted-foreground"}`}
                key={value}
                onClick={() => setTab(value)}
                role="tab"
                aria-selected={tab === value}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        {tab === "overview" ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Card
              detail="bytes per second"
              title="Download"
              value={`${data.downloadBytesPerSecond} B/s`}
            />
            <Card
              detail="bytes per second"
              title="Upload"
              value={`${data.uploadBytesPerSecond} B/s`}
            />
          </div>
        ) : (
          <p className="mt-5 rounded-md bg-canvas p-4 text-body text-muted-foreground">
            Activity arrives through the bounded Event Iterator and is rendered on the Events page.
          </p>
        )}
      </section>
    </>
  );
}

export function StatusPage() {
  const query = useCutoverView("status.snapshot");
  return (
    <Page
      description="A contract-first status surface backed by one XState session actor and Query cache."
      eyebrow="Runtime"
      title="Status"
    >
      <StatusContent data={query.data} />
    </Page>
  );
}

export function RoutesPage() {
  const query = useCutoverView("routes.snapshot");
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data?.groups ?? []).filter((group) =>
      `${group.label} ${group.children.join(" ")}`.toLowerCase().includes(normalized),
    );
  }, [query.data, search]);
  return (
    <Page
      description="Policy groups stay visible as a route graph projection; selection is presentation-only until a command actor is admitted."
      eyebrow="Navigation"
      title="Routes"
    >
      <section className="rounded-lg border border-hairline-soft bg-surface-soft p-5">
        <label
          className="grid gap-1.5 text-label-small text-muted-foreground"
          htmlFor="routes-search"
        >
          Search route groups
          <input
            className="min-h-10 rounded-md border border-hairline bg-canvas px-3 text-body text-ink"
            id="routes-search"
            onChange={(event) => setSearch(event.target.value)}
            value={search}
          />
        </label>
        {query.data ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-120 text-left text-body">
              <thead>
                <tr className="border-b border-hairline-soft text-caption text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 font-medium">Children</th>
                  <th className="px-3 py-2 font-medium">Selected</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr className="border-b border-hairline-soft last:border-0" key={group.id}>
                    <td className="px-3 py-3 font-medium">{group.label}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {group.children.join(", ") || "—"}
                    </td>
                    <td className="px-3 py-3">{group.selected ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {groups.length === 0 ? (
              <p className="p-4 text-body text-muted-foreground">No matching route groups.</p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5">
            <LoadingPanel label="route" />
          </div>
        )}
      </section>
    </Page>
  );
}

export function ProfilesPage() {
  const query = useCutoverView("profile.refresh");
  const [showSubscriptions, setShowSubscriptions] = useState(true);
  const profiles = query.data?.profiles ?? [];
  return (
    <Page
      description="Profiles are read through the shared profile projection. Import and activation remain explicit domain commands, so this surface never fakes a native effect."
      eyebrow="Configuration"
      title="Profiles"
    >
      <section className="rounded-lg border border-hairline-soft bg-surface-soft p-5">
        <label className="inline-flex min-h-10 items-center gap-2 text-body">
          <input
            checked={showSubscriptions}
            onChange={(event) => setShowSubscriptions(event.target.checked)}
            type="checkbox"
          />
          Show subscription sources
        </label>
        {query.data ? (
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {profiles
              .filter((profile) => showSubscriptions || profile.source !== "subscription")
              .map((profile) => (
                <article
                  className="rounded-md border border-hairline-soft bg-canvas p-4"
                  key={profile.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-medium">{profile.name}</h3>
                    <span className="rounded-full border border-hairline-soft px-2 py-0.5 text-caption">
                      {profile.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="mt-2 text-caption text-muted-foreground">
                    {profile.source} · updated {profile.updatedAt}
                  </p>
                </article>
              ))}
            {profiles.length === 0 ? (
              <p className="text-body text-muted-foreground">
                No profiles in the admitted projection.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5">
            <LoadingPanel label="profile" />
          </div>
        )}
      </section>
    </Page>
  );
}

export function TrafficPage() {
  const query = useCutoverView("traffic.snapshot");
  const [tab, setTab] = useState<"connections" | "rules">("connections");
  const [search, setSearch] = useState("");
  const normalized = search.trim().toLowerCase();
  const connections = (query.data?.connections ?? []).filter((item) =>
    `${item.destination} ${item.protocol}`.toLowerCase().includes(normalized),
  );
  const rules = (query.data?.rules ?? []).filter((item) =>
    `${item.target} ${item.action}`.toLowerCase().includes(normalized),
  );
  return (
    <Page
      description="Traffic is a bounded read projection. The page preserves filtering and tab state while command effects remain outside the Web renderer."
      eyebrow="Observability"
      title="Traffic"
    >
      <section className="rounded-lg border border-hairline-soft bg-surface-soft p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex rounded-md border border-hairline-soft p-1"
            role="tablist"
            aria-label="Traffic view"
          >
            {(["connections", "rules"] as const).map((value) => (
              <button
                className={`rounded px-3 py-1.5 text-metadata ${tab === value ? "bg-accent text-ink" : "text-muted-foreground"}`}
                key={value}
                onClick={() => setTab(value)}
                role="tab"
                aria-selected={tab === value}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
          <input
            aria-label="Filter traffic"
            className="min-h-9 rounded-md border border-hairline bg-canvas px-3 text-body"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter"
            value={search}
          />
        </div>
        {query.data ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-120 text-left text-body">
              <thead>
                <tr className="border-b border-hairline-soft text-caption text-muted-foreground">
                  <th className="px-3 py-2 font-medium">
                    {tab === "connections" ? "Destination" : "Target"}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {tab === "connections" ? "Protocol" : "Action"}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {tab === "connections" ? "Transfer" : "Rule"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tab === "connections"
                  ? connections.map((item) => (
                      <tr className="border-b border-hairline-soft last:border-0" key={item.id}>
                        <td className="px-3 py-3">{item.destination}</td>
                        <td className="px-3 py-3 text-muted-foreground">{item.protocol}</td>
                        <td className="px-3 py-3">
                          {item.downloadBytes} ↓ / {item.uploadBytes} ↑
                        </td>
                      </tr>
                    ))
                  : rules.map((item) => (
                      <tr className="border-b border-hairline-soft last:border-0" key={item.id}>
                        <td className="px-3 py-3">{item.target}</td>
                        <td className="px-3 py-3 text-muted-foreground">{item.action}</td>
                        <td className="px-3 py-3">{item.id}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-5">
            <LoadingPanel label="traffic" />
          </div>
        )}
      </section>
    </Page>
  );
}

export function EventsPage() {
  const query = useCutoverView("events.snapshot");
  const [level, setLevel] = useState<OrpcEventData["events"][number]["level"] | "all">("all");
  const events = (query.data?.events ?? []).filter(
    (event) => level === "all" || event.level === level,
  );
  return (
    <Page
      description="The Event Iterator remains bounded by the shared session adapter; this page only filters its Query projection."
      eyebrow="Observability"
      title="Events"
    >
      <section className="rounded-lg border border-hairline-soft bg-surface-soft p-5">
        <label
          className="grid max-w-60 gap-1.5 text-label-small text-muted-foreground"
          htmlFor="events-level"
        >
          Level
          <select
            className="min-h-10 rounded-md border border-hairline bg-canvas px-3 text-body text-ink"
            id="events-level"
            onChange={(event) => setLevel(event.target.value as typeof level)}
            value={level}
          >
            <option value="all">All levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        {query.data ? (
          <div className="mt-5 grid gap-2">
            {events.map((event) => (
              <article
                className="rounded-md border border-hairline-soft bg-canvas p-3"
                key={event.id}
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{event.message}</span>
                  <span className="text-caption text-muted-foreground">
                    {event.level} · {event.source}
                  </span>
                </div>
                <p className="mt-1 text-caption text-muted-foreground">{event.observedAt}</p>
              </article>
            ))}
            {events.length === 0 ? (
              <p className="text-body text-muted-foreground">No events match the selected level.</p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5">
            <LoadingPanel label="event" />
          </div>
        )}
      </section>
    </Page>
  );
}

export function SettingsPage() {
  const query = useCutoverView("settings.snapshot");
  const [compact, setCompact] = useState(false);
  const settings: OrpcSettingsData | undefined = query.data;
  return (
    <Page
      description="Settings keeps renderer preferences local and visibly read-only until an admitted domain command and native seam exist."
      eyebrow="Preferences"
      title="Settings"
    >
      <section
        className={`rounded-lg border border-hairline-soft bg-surface-soft p-5 ${compact ? "text-caption" : ""}`}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card
            detail="Query projection"
            title="Appearance"
            value={settings?.appearance ?? "Waiting"}
          />
          <Card
            detail="Query projection"
            title="Language"
            value={settings?.language ?? "Waiting"}
          />
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-hairline-soft bg-canvas p-4">
          <div>
            <h3 className="font-medium">Compact presentation</h3>
            <p className="mt-1 text-caption text-muted-foreground">
              Local UI state only; no operating-system effect is invoked.
            </p>
          </div>
          <button
            aria-pressed={compact}
            className="min-h-10 rounded-md border border-hairline-soft px-3 text-body hover:bg-accent"
            onClick={() => setCompact((current) => !current)}
            type="button"
          >
            {compact ? "Use comfortable spacing" : "Use compact spacing"}
          </button>
        </div>
        <p className="mt-4 text-caption text-muted-foreground">
          {settings?.readOnly
            ? "Write operations are intentionally unavailable in this admission."
            : "Waiting for the settings contract."}
        </p>
      </section>
    </Page>
  );
}
