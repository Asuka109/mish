import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { Gauge } from "@phosphor-icons/react/Gauge";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ListBullets } from "@phosphor-icons/react/ListBullets";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import { Pulse } from "@phosphor-icons/react/Pulse";
import { BrowserRouter, NavLink, Outlet, Route, Routes, useLocation } from "react-router";
import {
  EventsPage,
  ProfilesPage,
  RoutesPage,
  SettingsPage,
  StatusPage,
  TrafficPage,
} from "./pages/cutover-pages";

const navigation = [
  { href: "/status", label: "Status", icon: Gauge, description: "Runtime overview" },
  { href: "/routes", label: "Routes", icon: CirclesFour, description: "Policy groups" },
  { href: "/profiles", label: "Profiles", icon: FileText, description: "Profile inventory" },
  {
    href: "/traffic",
    label: "Traffic",
    icon: PlugsConnected,
    description: "Connections and rules",
  },
  { href: "/events", label: "Events", icon: ListBullets, description: "Session events" },
  {
    href: "/settings",
    label: "Settings",
    icon: GearSix,
    description: "Renderer preferences",
  },
] as const;

export const PRODUCT_ROUTE_PATHS = [
  "/status",
  "/routes",
  "/profiles",
  "/traffic",
  "/events",
  "/settings",
] as const;

function navigationClassName(isActive: boolean): string {
  return [
    "product-navigation-link group grid min-h-9.5 grid-cols-[20px_minmax(0,1fr)] items-center gap-2 rounded-md px-2.5",
    "border border-transparent text-body font-medium text-muted-foreground no-underline",
    "transition-[background-color,color,border-color] duration-120 hover:bg-sidebar-item-hover hover:text-ink",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-accent",
    isActive
      ? "border-sidebar-item-active-border bg-sidebar-item-active text-ink shadow-sidebar-item-active"
      : "",
  ].join(" ");
}

function MobileNavigation() {
  return (
    <nav
      aria-label="Primary navigation"
      className="product-mobile-navigation hidden min-w-0 gap-1 overflow-x-auto border-b border-hairline bg-canvas px-2 py-1 max-shell-mobile:flex"
    >
      {navigation.map(({ href, icon: Icon, label }) => (
        <NavLink
          aria-label={`${label} mobile navigation`}
          className={({ isActive }) =>
            `inline-flex min-h-11 min-w-18 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-micro font-medium no-underline transition-[background-color,color] duration-120 ${isActive ? "bg-accent text-ink" : "text-muted-foreground hover:bg-accent hover:text-ink"}`
          }
          end={href === "/status"}
          key={href}
          to={href}
        >
          <Icon aria-hidden="true" size={18} weight="regular" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function Sidebar() {
  return (
    <aside className="product-sidebar flex min-w-0 flex-col bg-sidebar-background px-2.5 py-3.5 text-fg max-shell-mobile:hidden">
      <div className="flex h-12 items-center gap-2 px-2" data-product-brand="mish">
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-md bg-ink text-caption font-semibold text-canvas"
        >
          M
        </span>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold tracking-title-tight text-ink">Mish</p>
          <p className="truncate text-caption text-muted-foreground">Network workspace</p>
        </div>
      </div>

      <nav aria-label="Primary navigation" className="mt-3 flex min-h-0 flex-1 flex-col gap-0.75">
        <p className="px-2.5 pb-1.5 text-micro font-medium uppercase tracking-label text-muted-foreground">
          Workspace
        </p>
        {navigation.map(({ href, icon: Icon, label, description }) => (
          <NavLink
            className={({ isActive }) => navigationClassName(isActive)}
            end={href === "/status"}
            key={href}
            title={description}
            to={href}
          >
            <Icon aria-hidden="true" className="size-sidebar-icon" weight="regular" />
            <span className="min-w-0 truncate">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 grid gap-2 border-t border-sidebar-divider pt-3" data-product-authority>
        <div className="flex items-center gap-2 px-2.5 text-caption text-muted-foreground">
          <Pulse aria-hidden="true" className="size-3.5 text-success" weight="regular" />
          <span>oRPC / Query</span>
        </div>
        <p className="px-2.5 text-micro leading-4 text-muted-foreground">
          Read-only projections are available. Commands stay disabled until their domain and host
          effects are admitted.
        </p>
      </div>
    </aside>
  );
}

function pageTitle(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "") || "/status";
  const entry = navigation.find(
    ({ href }) => normalized === href || normalized.startsWith(`${href}/`),
  );
  return entry?.label ?? "Mish";
}

/** The shared product chrome used by Web and the future Electron renderer. */
export function ProductShell() {
  const location = useLocation();
  const title = pageTitle(location.pathname);

  return (
    <div
      className="product-app-shell relative grid h-screen h-dvh min-h-0 w-full grid-cols-[164px_minmax(0,1fr)] overflow-hidden bg-surface-soft max-shell-mobile:grid-cols-1 max-shell-mobile:grid-rows-[minmax(0,1fr)_auto]"
      data-product-surface="mish"
    >
      <a
        className="sr-only z-80 rounded-md bg-canvas px-3 py-2 text-body text-ink focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus-visible:outline-2 focus-visible:outline-offset-2"
        href="#product-content"
      >
        Skip to content
      </a>
      <Sidebar />
      <section className="product-workspace relative grid min-h-0 min-w-0 grid-rows-[56px_minmax(0,1fr)] overflow-hidden border border-hairline bg-canvas shadow-panel max-shell-mobile:row-start-1 max-shell-mobile:mx-1.5 max-shell-mobile:mt-1.5 max-shell-mobile:rounded-compact">
        <header className="product-toolbar flex min-w-0 items-center justify-between gap-4 border-b border-hairline px-6 max-shell-mobile:px-3">
          <div className="min-w-0">
            <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">
              Mish workspace
            </p>
            <span className="block truncate text-body font-medium text-ink" data-product-title>
              {title}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-label="Read-only oRPC projection"
              className="inline-flex h-7.5 items-center gap-1.5 rounded-md border border-hairline bg-surface-soft px-2.5 text-caption text-muted-foreground max-toolbar-compact:hidden"
              data-contract-boundary="orpc"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              Read-only
            </span>
            <span className="inline-flex h-7.5 items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2.5 text-caption text-muted-foreground">
              <Pulse aria-hidden="true" className="size-3.5" weight="regular" />
              Session
            </span>
          </div>
        </header>
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <MobileNavigation />
          <main
            className="product-content-scroll min-h-0 min-w-0 overflow-auto overscroll-contain"
            id="product-content"
            tabIndex={-1}
          >
            <Outlet />
          </main>
        </div>
      </section>
    </div>
  );
}

function UnknownPage() {
  return (
    <div className="mx-auto grid min-h-full max-w-page place-content-center gap-3 px-page-gutter py-xxl text-center">
      <h1 className="text-title font-semibold text-ink">Page not found</h1>
      <p className="text-body text-muted-foreground">Choose a workspace destination to continue.</p>
      <NavLink className="text-body text-ink underline underline-offset-4" to="/status">
        Return to Status
      </NavLink>
    </div>
  );
}

/** The six-route product surface. Remote values are supplied by CutoverViewProvider. */
export function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ProductShell />}>
          <Route index element={<StatusPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="profiles" element={<ProfilesPage />} />
          <Route path="traffic" element={<TrafficPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<UnknownPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
