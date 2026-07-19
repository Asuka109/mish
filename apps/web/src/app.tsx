import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { NotFoundPage } from "./pages/not-found-page";
import { StatusPage } from "./pages/status-page";

const EventsPage = lazy(() =>
  import("./pages/events-page").then(({ EventsPage }) => ({ default: EventsPage })),
);
const ProfilesPage = lazy(() =>
  import("./pages/profiles-page").then(({ ProfilesPage }) => ({ default: ProfilesPage })),
);
const RoutesPage = lazy(() =>
  import("./pages/routes-page").then(({ RoutesPage }) => ({ default: RoutesPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings-page").then(({ SettingsPage }) => ({ default: SettingsPage })),
);
const TrafficPage = lazy(() =>
  import("./pages/traffic-page").then(({ TrafficPage }) => ({ default: TrafficPage })),
);

function renderDeferredRoute(children: ReactNode) {
  return (
    <Suspense
      fallback={
        <div aria-busy="true" className="page-scroll route-loading">
          <div aria-hidden="true" className="route-loading-placeholder" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate replace to="/status" />} />
        <Route element={<StatusPage />} path="status" />
        <Route element={renderDeferredRoute(<RoutesPage />)} path="routes" />
        <Route element={renderDeferredRoute(<ProfilesPage />)} path="profiles" />
        <Route element={renderDeferredRoute(<TrafficPage />)} path="traffic" />
        <Route element={renderDeferredRoute(<EventsPage />)} path="events" />
        <Route element={renderDeferredRoute(<SettingsPage />)} path="settings" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
