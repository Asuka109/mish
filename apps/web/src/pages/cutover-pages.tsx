import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Empty } from "@phosphor-icons/react/Empty";
import { Warning } from "@phosphor-icons/react/Warning";
import { useMemo, useState, type ReactNode } from "react";
import type {
  OrpcEventData,
  OrpcProfileData,
  OrpcRouteData,
  OrpcSettingsData,
  OrpcStatusData,
  OrpcTrafficData,
} from "@mish/contracts";
import { useCutoverView, type CutoverViewDataByOperation } from "../data/cutover-view-facade";

type ProjectionQuery<T> = {
  readonly data: T | null | undefined;
  readonly error: unknown;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly refetch: () => Promise<unknown>;
};

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
    <div
      className="product-page mx-auto grid min-h-full w-full max-w-page-wide gap-6 px-page-gutter py-xxl max-page-compact:px-page-gutter-compact max-page-compact:py-xl max-shell-mobile:px-page-gutter-mobile max-shell-mobile:py-5"
      data-product-page={title.toLowerCase()}
    >
      <header className="product-page-heading border-b border-hairline-soft pb-5">
        <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-title font-semibold tracking-title-tight text-ink">{title}</h1>
        <p className="mt-2 max-w-3xl text-body leading-6 text-muted-foreground">{description}</p>
      </header>
      {children}
    </div>
  );
}

function Card({
  detail,
  label,
  value,
}: {
  readonly detail: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <section className="product-metric-card min-w-0 rounded-lg border border-hairline bg-canvas p-4 shadow-panel">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p
        className="mt-2 truncate text-title font-semibold tabular-nums text-ink"
        data-card-value={label.toLowerCase()}
      >
        {value}
      </p>
      <p className="mt-1 text-caption text-muted-foreground">{detail}</p>
    </section>
  );
}

function ProjectionPanel<T>({
  children,
  emptyMessage,
  label,
  query,
}: {
  readonly children: (data: T) => ReactNode;
  readonly emptyMessage: string;
  readonly label: string;
  readonly query: ProjectionQuery<T>;
}) {
  if (query.isPending && !query.data) {
    return (
      <output
        aria-busy="true"
        aria-live="polite"
        className="grid min-h-36 place-items-center rounded-lg border border-hairline bg-surface-soft p-6 text-center"
        data-projection-state="loading"
      >
        <span className="grid justify-items-center gap-2 text-muted-foreground">
          <CircleNotch aria-hidden="true" className="size-5 animate-spin" />
          <span>Loading {label} projection…</span>
        </span>
      </output>
    );
  }

  if (query.isError && !query.data) {
    const message =
      query.error instanceof Error ? query.error.message : "The projection is unavailable.";
    return (
      <section
        aria-labelledby={`${label}-projection-error`}
        className="grid min-h-36 gap-3 rounded-lg border border-feedback-error-border bg-surface-soft p-6"
        data-projection-state="error"
        role="alert"
      >
        <div className="flex items-start gap-3">
          <Warning aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-error" />
          <div className="grid gap-1">
            <h2 className="font-medium text-ink" id={`${label}-projection-error`}>
              {label} projection unavailable
            </h2>
            <p className="text-body text-muted-foreground">{message}</p>
          </div>
        </div>
        <button
          className="min-h-10 w-fit rounded-md border border-hairline bg-canvas px-3 text-body font-medium text-ink hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent"
          onClick={() => void query.refetch()}
          type="button"
        >
          Try again
        </button>
      </section>
    );
  }

  if (!query.data) {
    return (
      <section
        aria-live="polite"
        className="grid min-h-36 place-items-center rounded-lg border border-dashed border-hairline p-6 text-center"
        data-projection-state="empty"
      >
        <div className="grid justify-items-center gap-2 text-muted-foreground">
          <Empty aria-hidden="true" className="size-5" />
          <p>{emptyMessage}</p>
        </div>
      </section>
    );
  }

  return children(query.data);
}

function Panel({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) {
  const titleId = `panel-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section
      aria-labelledby={titleId}
      className="product-panel min-w-0 rounded-lg border border-hairline bg-canvas shadow-panel"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline-soft px-5 py-4 max-shell-mobile:px-4">
        <div className="min-w-0">
          <h2 className="text-body font-semibold text-ink" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-caption leading-4.5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </header>
      <div className="p-5 max-shell-mobile:p-4">{children}</div>
    </section>
  );
}

function StatusContent({ data }: { readonly data: OrpcStatusData }) {
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  return (
    <div className="grid gap-5">
      <div className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline-soft sm:grid-cols-2 xl:grid-cols-4">
        <Card detail="Current runtime phase" label="Phase" value={data.phase} />
        <Card
          detail="Selected profile from Query"
          label="Profile"
          value={data.profileName ?? "None"}
        />
        <Card
          detail="Observed active sessions"
          label="Connections"
          value={String(data.activeConnections)}
        />
        <Card
          detail="Current transfer rate"
          label="Throughput"
          value={`${data.downloadBytesPerSecond + data.uploadBytesPerSecond} B/s`}
        />
      </div>
      <Panel
        description="Runtime values are remote Query projections. Tabs and focus remain renderer-local presentation state."
        title="Runtime overview"
      >
        <div className="grid gap-5">
          <div
            aria-label="Status views"
            className="flex flex-wrap gap-1 rounded-md border border-hairline bg-surface-soft p-1"
            role="tablist"
          >
            {(["overview", "activity"] as const).map((value) => (
              <button
                aria-controls={`status-${value}-panel`}
                aria-selected={tab === value}
                className={`min-h-9 rounded-md px-3 text-metadata font-medium transition-[background-color,color] duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent ${tab === value ? "bg-canvas text-ink shadow-tabs-active" : "text-muted-foreground hover:bg-accent hover:text-ink"}`}
                key={value}
                onClick={() => setTab(value)}
                role="tab"
                type="button"
              >
                {value === "overview" ? "Overview" : "Activity"}
              </button>
            ))}
          </div>
          {tab === "overview" ? (
            <div className="grid gap-3 sm:grid-cols-2" id="status-overview-panel" role="tabpanel">
              <Card
                detail="Download rate"
                label="Download"
                value={`${data.downloadBytesPerSecond} B/s`}
              />
              <Card
                detail="Upload rate"
                label="Upload"
                value={`${data.uploadBytesPerSecond} B/s`}
              />
            </div>
          ) : (
            <div
              className="grid gap-3 rounded-md border border-dashed border-hairline bg-surface-soft p-4"
              id="status-activity-panel"
              role="tabpanel"
            >
              <div className="flex items-center gap-2 text-body font-medium text-ink">
                <CheckCircle aria-hidden="true" className="size-4 text-success" />
                Event activity is available on the Events route
              </div>
              <p className="text-caption text-muted-foreground">
                The session Event Iterator remains bounded and Query-owned; this tab does not start
                a second stream.
              </p>
            </div>
          )}
        </div>
      </Panel>
    </div>
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
      <ProjectionPanel<OrpcStatusData>
        emptyMessage="No status projection has been published by the current session."
        label="Status"
        query={query}
      >
        {(data) => <StatusContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

function RoutesContent({ data }: { readonly data: OrpcRouteData }) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return data.groups.filter((group) =>
      `${group.label} ${group.children.join(" ")}`.toLowerCase().includes(normalized),
    );
  }, [data.groups, search]);
  return (
    <Panel
      description="Policy groups stay visible as a route graph projection. Selection is presentation-only until a command actor is admitted."
      title="Route graph"
    >
      <div className="grid gap-4">
        <label
          className="grid max-w-md gap-1.5 text-caption font-medium text-muted-foreground"
          htmlFor="routes-search"
        >
          Search route groups
          <input
            aria-describedby="routes-search-help"
            className="min-h-10 rounded-md border border-hairline bg-canvas px-3 text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent"
            id="routes-search"
            onChange={(event) => setSearch(event.target.value)}
            type="search"
            value={search}
          />
          <span className="text-micro font-normal" id="routes-search-help">
            Filter the Query projection locally.
          </span>
        </label>
        {groups.length === 0 ? (
          <div className="grid min-h-32 place-items-center rounded-md border border-dashed border-hairline p-5 text-center text-body text-muted-foreground">
            No matching route groups.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-hairline">
            <table className="w-full min-w-140 border-collapse text-left text-metadata">
              <caption className="sr-only">Route groups and selected children</caption>
              <thead className="bg-surface-soft text-caption text-muted-foreground">
                <tr>
                  <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
                    Group
                  </th>
                  <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
                    Selected
                  </th>
                  <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
                    Children
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr
                    className="border-b border-hairline-soft last:border-0 hover:bg-accent"
                    key={group.id}
                  >
                    <th className="px-3 py-3 font-medium text-ink" scope="row">
                      {group.label}
                    </th>
                    <td className="px-3 py-3 text-muted-foreground">{group.selected ?? "None"}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {group.children.join(", ") || "None"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function RoutesPage() {
  const query = useCutoverView("routes.snapshot");
  return (
    <Page
      description="Browse the current policy-group hierarchy without issuing a route-selection command."
      eyebrow="Navigation"
      title="Routes"
    >
      <ProjectionPanel<OrpcRouteData>
        emptyMessage="No route graph projection has been published by the current session."
        label="Routes"
        query={query}
      >
        {(data) => <RoutesContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

function ProfilesContent({ data }: { readonly data: OrpcProfileData }) {
  const [showSubscriptions, setShowSubscriptions] = useState(true);
  const profiles = data.profiles.filter(
    (profile) => showSubscriptions || profile.source !== "subscription",
  );
  return (
    <Panel
      description="Profiles are read through the shared projection. Import and activation remain unavailable until their domain command and host seam are admitted."
      title="Profile inventory"
    >
      <div className="grid gap-4">
        <label className="inline-flex min-h-10 w-fit items-center gap-2 text-body text-ink">
          <input
            checked={showSubscriptions}
            onChange={(event) => setShowSubscriptions(event.target.checked)}
            type="checkbox"
          />
          Show subscription sources
        </label>
        {profiles.length === 0 ? (
          <div className="grid min-h-32 place-items-center rounded-md border border-dashed border-hairline p-5 text-center text-body text-muted-foreground">
            No profiles match this view.
          </div>
        ) : (
          <div className="grid gap-px overflow-hidden rounded-md border border-hairline bg-hairline-soft md:grid-cols-2">
            {profiles.map((profile) => (
              <article className="grid gap-3 bg-canvas p-4" key={profile.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-body font-medium text-ink">{profile.name}</h3>
                    <p className="mt-1 text-caption text-muted-foreground">{profile.source}</p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption ${profile.active ? "border-badge-success-border bg-badge-success-background text-success-text" : "border-hairline text-muted-foreground"}`}
                  >
                    {profile.active ? <CheckCircle aria-hidden="true" className="size-3" /> : null}
                    {profile.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <p className="text-caption text-muted-foreground">Updated {profile.updatedAt}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function ProfilesPage() {
  const query = useCutoverView("profile.refresh");
  return (
    <Page
      description="Review the profiles currently visible to the authenticated session."
      eyebrow="Configuration"
      title="Profiles"
    >
      <ProjectionPanel<OrpcProfileData>
        emptyMessage="No profile projection has been published by the current session."
        label="Profiles"
        query={query}
      >
        {(data) => <ProfilesContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

function TrafficContent({ data }: { readonly data: OrpcTrafficData }) {
  const [tab, setTab] = useState<"connections" | "rules">("connections");
  const [search, setSearch] = useState("");
  const normalized = search.trim().toLowerCase();
  const connections = data.connections.filter((item) =>
    `${item.destination} ${item.protocol}`.toLowerCase().includes(normalized),
  );
  const rules = data.rules.filter((item) =>
    `${item.target} ${item.action}`.toLowerCase().includes(normalized),
  );
  return (
    <Panel
      description="Traffic is a bounded read projection. Filtering and view selection stay local to this renderer."
      title="Traffic overview"
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            aria-label="Traffic views"
            className="flex gap-1 rounded-md border border-hairline bg-surface-soft p-1"
            role="tablist"
          >
            {(["connections", "rules"] as const).map((value) => (
              <button
                aria-selected={tab === value}
                className={`min-h-9 rounded-md px-3 text-metadata font-medium transition-[background-color,color] duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent ${tab === value ? "bg-canvas text-ink shadow-tabs-active" : "text-muted-foreground hover:bg-accent hover:text-ink"}`}
                key={value}
                onClick={() => setTab(value)}
                role="tab"
                type="button"
              >
                {value === "connections" ? "Connections" : "Rules"}
              </button>
            ))}
          </div>
          <label
            className="grid min-w-52 max-w-72 flex-1 gap-1 text-caption text-muted-foreground max-shell-mobile:min-w-0"
            htmlFor="traffic-filter"
          >
            <span className="sr-only">Filter traffic</span>
            <input
              className="min-h-10 rounded-md border border-hairline bg-canvas px-3 text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent"
              id="traffic-filter"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter traffic"
              type="search"
              value={search}
            />
          </label>
        </div>
        {tab === "connections" ? (
          <TrafficConnections rows={connections} />
        ) : (
          <TrafficRules rows={rules} />
        )}
      </div>
    </Panel>
  );
}

function TrafficConnections({ rows }: { readonly rows: OrpcTrafficData["connections"] }) {
  if (rows.length === 0) return <InlineEmpty message="No connections match this view." />;
  return (
    <div className="overflow-x-auto rounded-md border border-hairline">
      <table className="w-full min-w-140 border-collapse text-left text-metadata">
        <caption className="sr-only">Observed traffic connections</caption>
        <thead className="bg-surface-soft text-caption text-muted-foreground">
          <tr>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Destination
            </th>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Protocol
            </th>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Download
            </th>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Upload
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr
              className="border-b border-hairline-soft last:border-0 hover:bg-accent"
              key={item.id}
            >
              <th className="px-3 py-3 font-medium text-ink" scope="row">
                {item.destination}
              </th>
              <td className="px-3 py-3 text-muted-foreground">{item.protocol}</td>
              <td className="px-3 py-3 text-traffic-download">
                <ArrowDown aria-hidden="true" className="me-1 inline size-3.5" />
                {item.downloadBytes} B
              </td>
              <td className="px-3 py-3 text-traffic-upload">
                <ArrowUp aria-hidden="true" className="me-1 inline size-3.5" />
                {item.uploadBytes} B
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrafficRules({ rows }: { readonly rows: OrpcTrafficData["rules"] }) {
  if (rows.length === 0) return <InlineEmpty message="No rules match this view." />;
  return (
    <div className="overflow-x-auto rounded-md border border-hairline">
      <table className="w-full min-w-120 border-collapse text-left text-metadata">
        <caption className="sr-only">Observed traffic rules</caption>
        <thead className="bg-surface-soft text-caption text-muted-foreground">
          <tr>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Target
            </th>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Action
            </th>
            <th className="border-b border-hairline px-3 py-2.5 font-medium" scope="col">
              Rule
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr
              className="border-b border-hairline-soft last:border-0 hover:bg-accent"
              key={item.id}
            >
              <th className="px-3 py-3 font-medium text-ink" scope="row">
                {item.target}
              </th>
              <td className="px-3 py-3 text-muted-foreground">{item.action}</td>
              <td className="px-3 py-3 font-mono text-caption text-muted-foreground">{item.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InlineEmpty({ message }: { readonly message: string }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed border-hairline p-5 text-center text-body text-muted-foreground">
      {message}
    </div>
  );
}

export function TrafficPage() {
  const query = useCutoverView("traffic.snapshot");
  return (
    <Page
      description="Inspect the connection and rule projections available from the current session."
      eyebrow="Observability"
      title="Traffic"
    >
      <ProjectionPanel<OrpcTrafficData>
        emptyMessage="No traffic projection has been published by the current session."
        label="Traffic"
        query={query}
      >
        {(data) => <TrafficContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

function EventsContent({ data }: { readonly data: OrpcEventData }) {
  const [level, setLevel] = useState<OrpcEventData["events"][number]["level"] | "all">("all");
  const events = data.events.filter((event) => level === "all" || event.level === level);
  return (
    <Panel
      description="Event records are a bounded Query projection. Filtering does not create another Event Iterator consumer."
      title="Session events"
    >
      <div className="grid gap-4">
        <label
          className="grid max-w-56 gap-1.5 text-caption font-medium text-muted-foreground"
          htmlFor="events-level"
        >
          Level
          <select
            className="min-h-10 rounded-md border border-hairline bg-canvas px-3 text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent"
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
        {events.length === 0 ? (
          <InlineEmpty message="No events match the selected level." />
        ) : (
          <ol className="grid gap-2" aria-label="Event records">
            {events.map((event) => (
              <li
                className="grid gap-2 rounded-md border border-hairline-soft bg-surface-soft p-3"
                key={event.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 wrap-anywhere text-body font-medium text-ink">
                    {event.message}
                  </p>
                  <span className="shrink-0 rounded-full border border-hairline bg-canvas px-2 py-0.5 text-caption text-muted-foreground">
                    {event.level}
                  </span>
                </div>
                <p className="text-caption text-muted-foreground">
                  {event.source} · <time dateTime={event.observedAt}>{event.observedAt}</time>
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

export function EventsPage() {
  const query = useCutoverView("events.snapshot");
  return (
    <Page
      description="Review the bounded event records delivered by the authenticated session."
      eyebrow="Observability"
      title="Events"
    >
      <ProjectionPanel<OrpcEventData>
        emptyMessage="No event projection has been published by the current session."
        label="Events"
        query={query}
      >
        {(data) => <EventsContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

function SettingsContent({ data }: { readonly data: OrpcSettingsData }) {
  const [compact, setCompact] = useState(false);
  return (
    <div className="grid gap-5">
      <Panel
        description="These values are observed from the Query projection. Write operations remain unavailable in this read-only admission."
        title="Appearance and language"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Card detail="Current renderer preference" label="Appearance" value={data.appearance} />
          <Card detail="Current locale preference" label="Language" value={data.language} />
        </div>
      </Panel>
      <Panel
        description="This control changes presentation only and never invokes a host or network effect."
        title="Local presentation"
      >
        <div className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-hairline-soft bg-surface-soft px-3 py-2 text-body text-ink">
          <div>
            <label className="block font-medium" htmlFor="settings-compact-spacing">
              Compact spacing
            </label>
            <p className="mt-0.5 text-caption text-muted-foreground">
              A renderer-local preference for this view.
            </p>
          </div>
          <input
            aria-describedby="settings-read-only-note"
            checked={compact}
            id="settings-compact-spacing"
            onChange={(event) => setCompact(event.target.checked)}
            type="checkbox"
          />
        </div>
        <p className="mt-3 text-caption text-muted-foreground" id="settings-read-only-note">
          {data.readOnly
            ? "Write operations are intentionally unavailable."
            : "Waiting for the settings contract."}
        </p>
      </Panel>
    </div>
  );
}

export function SettingsPage() {
  const query = useCutoverView("settings.snapshot");
  return (
    <Page
      description="Keep renderer preferences understandable while native settings commands remain outside the admitted read surface."
      eyebrow="Preferences"
      title="Settings"
    >
      <ProjectionPanel<OrpcSettingsData>
        emptyMessage="No settings projection has been published by the current session."
        label="Settings"
        query={query}
      >
        {(data) => <SettingsContent data={data} />}
      </ProjectionPanel>
    </Page>
  );
}

export type CutoverProductData = CutoverViewDataByOperation;
