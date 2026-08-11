import { Button, Spinner } from "@mish/ui";
import {
  Component,
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useId,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import { useI18nContext } from "./i18n/i18n-react";
import { NotFoundPage } from "./pages/not-found-page";
import { StatusPage } from "./pages/status-page";

type RouteModule = ComponentType<Record<string, never>>;
export type RouteModuleLoader = () => Promise<{ default: RouteModule }>;

const loadEventsPage: RouteModuleLoader = () =>
  import("./pages/events-page").then(({ EventsPage }) => ({ default: EventsPage }));
const loadProfilesPage: RouteModuleLoader = () =>
  import("./pages/profiles-page").then(({ ProfilesPage }) => ({ default: ProfilesPage }));
const loadRoutesPage: RouteModuleLoader = () =>
  import("./pages/routes-page").then(({ RoutesPage }) => ({ default: RoutesPage }));
const loadSettingsPage: RouteModuleLoader = () =>
  import("./pages/settings-page").then(({ SettingsPage }) => ({ default: SettingsPage }));
const loadTrafficPage: RouteModuleLoader = () =>
  import("./pages/traffic-page").then(({ TrafficPage }) => ({ default: TrafficPage }));

type LazyRouteComponent = LazyExoticComponent<RouteModule>;
const EventsPage = lazy(loadEventsPage);
const ProfilesPage = lazy(loadProfilesPage);
const RoutesPage = lazy(loadRoutesPage);
const SettingsPage = lazy(loadSettingsPage);
const TrafficPage = lazy(loadTrafficPage);

export const routeRetryLimit = 2;

export const routePendingClassName = "route-loading grid min-h-full place-items-center";

export function RoutePending() {
  const { LL } = useI18nContext();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div aria-busy="true" className={routePendingClassName}>
      {visible ? (
        <div className="grid size-7 place-items-center text-muted-foreground" role="status">
          <Spinner />
          <span className="sr-only">{LL.common.loading()}</span>
        </div>
      ) : null}
    </div>
  );
}

const routeFailureClassName =
  "route-error grid min-h-full place-content-center gap-3 px-page-gutter py-xl text-center text-muted-foreground";

interface RouteFailureProps {
  onRetry: () => void;
  retryCount: number;
}

function RouteFailure({ onRetry, retryCount }: RouteFailureProps) {
  const { LL } = useI18nContext();
  const titleId = useId();
  const canRetry = retryCount < routeRetryLimit;

  return (
    <div aria-labelledby={titleId} className={routeFailureClassName} role="alert">
      <div className="grid gap-1.5">
        <h1 className="text-title font-semibold text-ink" id={titleId}>
          {LL.routeError.title()}
        </h1>
        <p>{canRetry ? LL.routeError.description() : LL.routeError.exhausted()}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canRetry ? (
          <Button autoFocus onClick={onRetry} variant="outline">
            {LL.routeError.retry()}
          </Button>
        ) : null}
        <Link
          className="inline-flex min-h-8.5 items-center justify-center rounded-md px-3.25 text-metadata font-medium text-fg no-underline hover:bg-accent hover:text-ink"
          to="/status"
        >
          {LL.routeError.returnToStatus()}
        </Link>
      </div>
    </div>
  );
}

interface RouteErrorBoundaryProps {
  children: ReactNode;
  onRetry: () => void;
  retryCount: number;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (this.state.error) {
      return <RouteFailure onRetry={this.props.onRetry} retryCount={this.props.retryCount} />;
    }

    return this.props.children;
  }
}

interface RouteRecoveryProps {
  children: ReactNode;
}

export function RouteRecovery({ children }: RouteRecoveryProps) {
  const [retryCount, setRetryCount] = useState(0);
  const retry = () =>
    setRetryCount((current) => (current < routeRetryLimit ? current + 1 : current));

  return (
    <RouteErrorBoundary key={retryCount} onRetry={retry} retryCount={retryCount}>
      <Fragment key={retryCount}>{children}</Fragment>
    </RouteErrorBoundary>
  );
}

interface DeferredRouteProps {
  initialComponent?: LazyRouteComponent;
  loader: RouteModuleLoader;
}

export function DeferredRoute({ initialComponent, loader }: DeferredRouteProps) {
  const [attempt, setAttempt] = useState(() => ({
    count: 0,
    component: initialComponent ?? lazy(loader),
  }));
  const retry = () =>
    setAttempt((current) =>
      current.count < routeRetryLimit
        ? { count: current.count + 1, component: lazy(loader) }
        : current,
    );
  const LazyRoute = attempt.component;

  return (
    <RouteErrorBoundary key={attempt.count} onRetry={retry} retryCount={attempt.count}>
      <Suspense fallback={<RoutePending />}>
        <LazyRoute />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function renderRouteElement(
  element: ReactNode | undefined,
  loader: RouteModuleLoader,
  initialComponent: LazyRouteComponent,
) {
  return element == null ? (
    <DeferredRoute initialComponent={initialComponent} loader={loader} />
  ) : (
    <RouteRecovery>{element}</RouteRecovery>
  );
}

interface ProductRoutesProps {
  routesChildElement?: ReactNode;
  routesElement?: ReactNode;
  routesGroupElement?: ReactNode;
  settingsChildElement?: ReactNode;
  settingsElement?: ReactNode;
  statusElement?: ReactNode;
  shell: ReactNode;
}

export function ProductRoutes({
  routesChildElement,
  routesElement,
  routesGroupElement,
  settingsChildElement,
  settingsElement,
  shell,
  statusElement = <StatusPage />,
}: ProductRoutesProps) {
  return (
    <Routes>
      <Route element={shell}>
        <Route index element={<Navigate replace to="/status" />} />
        <Route element={<RouteRecovery>{statusElement}</RouteRecovery>} path="status" />
        <Route
          element={renderRouteElement(routesElement, loadRoutesPage, RoutesPage)}
          path="routes"
        />
        <Route
          element={renderRouteElement(routesGroupElement, loadRoutesPage, RoutesPage)}
          path="routes/:groupId"
        />
        {routesChildElement ? (
          <Route
            element={<RouteRecovery>{routesChildElement}</RouteRecovery>}
            path="routes/:groupId/children/:childId"
          />
        ) : null}
        <Route
          element={<DeferredRoute initialComponent={ProfilesPage} loader={loadProfilesPage} />}
          path="profiles"
        />
        <Route
          element={<DeferredRoute initialComponent={TrafficPage} loader={loadTrafficPage} />}
          path="traffic"
        />
        <Route
          element={<DeferredRoute initialComponent={EventsPage} loader={loadEventsPage} />}
          path="events"
        />
        <Route element={<Navigate replace to="/traffic" />} path="activity" />
        <Route
          element={renderRouteElement(settingsElement, loadSettingsPage, SettingsPage)}
          path="settings"
        />
        {settingsChildElement ? (
          <Route
            element={<RouteRecovery>{settingsChildElement}</RouteRecovery>}
            path="settings/:section"
          />
        ) : null}
        <Route
          element={
            <RouteRecovery>
              <NotFoundPage />
            </RouteRecovery>
          }
          path="*"
        />
      </Route>
    </Routes>
  );
}
