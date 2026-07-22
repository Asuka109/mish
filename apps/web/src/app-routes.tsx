import { Spinner } from "@mish/ui";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useI18nContext } from "./i18n/i18n-react";
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

export function RoutePending() {
  const { LL } = useI18nContext();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div aria-busy="true" className="route-loading grid place-items-center">
      {visible ? (
        <div className="grid size-7 place-items-center text-muted-foreground" role="status">
          <Spinner />
          <span className="sr-only">{LL.common.loading()}</span>
        </div>
      ) : null}
    </div>
  );
}

function renderDeferredRoute(children: ReactNode) {
  return <Suspense fallback={<RoutePending />}>{children}</Suspense>;
}

interface ProductRoutesProps {
  shell: ReactNode;
}

export function ProductRoutes({ shell }: ProductRoutesProps) {
  return (
    <Routes>
      <Route element={shell}>
        <Route index element={<Navigate replace to="/status" />} />
        <Route element={<StatusPage />} path="status" />
        <Route element={renderDeferredRoute(<RoutesPage />)} path="routes" />
        <Route element={renderDeferredRoute(<ProfilesPage />)} path="profiles" />
        <Route element={renderDeferredRoute(<TrafficPage />)} path="traffic" />
        <Route element={renderDeferredRoute(<EventsPage />)} path="events" />
        <Route element={<Navigate replace to="/traffic" />} path="activity" />
        <Route element={<Navigate replace to="/events?diagnostics=1" />} path="diagnostics" />
        <Route element={renderDeferredRoute(<SettingsPage />)} path="settings" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
