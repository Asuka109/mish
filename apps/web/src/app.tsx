import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { DestinationPage } from "./pages/destination-page";
import { NotFoundPage } from "./pages/not-found-page";
import { RoutesPage } from "./pages/routes-page";
import { StatusPage } from "./pages/status-page";
import { TrafficPage } from "./pages/traffic-page";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate replace to="/status" />} />
        <Route element={<StatusPage />} path="status" />
        <Route element={<RoutesPage />} path="routes" />
        <Route element={<DestinationPage destination="profiles" />} path="profiles" />
        <Route element={<TrafficPage />} path="traffic" />
        <Route element={<DestinationPage destination="events" />} path="events" />
        <Route element={<DestinationPage destination="settings" />} path="settings" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
