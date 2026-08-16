import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";
import {
  EventsPage,
  ProfilesPage,
  RoutesPage,
  SettingsPage,
  StatusPage,
  TrafficPage,
} from "./pages/cutover-pages";

const navigation = [
  ["/status", "Status"],
  ["/routes", "Routes"],
  ["/profiles", "Profiles"],
  ["/traffic", "Traffic"],
  ["/events", "Events"],
  ["/settings", "Settings"],
] as const;

function ProductShell() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-hairline-soft bg-surface-soft px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-metadata font-medium uppercase tracking-wider text-muted-foreground">
              Mish
            </p>
            <h1 className="text-title font-semibold">Control surface</h1>
          </div>
          <span
            className="rounded-full border border-hairline-soft px-3 py-1 text-caption text-muted-foreground"
            data-contract-boundary="orpc"
          >
            oRPC session
          </span>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6 md:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Primary" className="flex gap-1 overflow-x-auto md:grid md:content-start">
          {navigation.map(([href, label]) => (
            <NavLink
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-body no-underline ${isActive ? "bg-accent text-ink" : "text-muted-foreground hover:bg-surface-soft hover:text-ink"}`
              }
              end={href === "/status"}
              key={href}
              to={href}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

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
          <Route path="*" element={<StatusPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
