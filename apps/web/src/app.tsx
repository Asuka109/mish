import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { EventsPage } from "./pages/events-page";
import { NotFoundPage } from "./pages/not-found-page";
import { ProfilesPage } from "./pages/profiles-page";
import { RoutesPage } from "./pages/routes-page";
import { StatusPage } from "./pages/status-page";
import { SettingsPage } from "./pages/settings-page";
import { TrafficPage } from "./pages/traffic-page";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate replace to="/status" />} />
        <Route element={<StatusPage />} path="status" />
        <Route element={<RoutesPage />} path="routes" />
        <Route element={<ProfilesPage />} path="profiles" />
        <Route element={<TrafficPage />} path="traffic" />
        <Route element={<EventsPage />} path="events" />
        <Route element={<SettingsPage />} path="settings" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
