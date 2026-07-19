import type { MobileFixtureBootstrapDto } from "@mish/contracts";
import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { House } from "@phosphor-icons/react/House";
import { Pulse } from "@phosphor-icons/react/Pulse";
import { NavLink, Outlet, useLocation } from "react-router";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";

const destinations = [
  { icon: House, key: "home", path: "/status" },
  { icon: CirclesFour, key: "routes", path: "/routes" },
  { icon: FileText, key: "profiles", path: "/profiles" },
  { icon: Pulse, key: "activity", path: "/traffic" },
  { icon: GearSix, key: "settings", path: "/settings" },
] as const;

interface MobileShellProps {
  fixture: MobileFixtureBootstrapDto;
}

function getTitle(LL: TranslationFunctions, pathname: string) {
  if (pathname === "/status") return LL.mobileNavigation.home();
  if (pathname === "/routes") return LL.mobileNavigation.routes();
  if (pathname === "/profiles") return LL.mobileNavigation.profiles();
  if (pathname === "/settings") return LL.mobileNavigation.settings();
  return LL.mobileNavigation.activity();
}

function isActivityPath(pathname: string) {
  return pathname === "/traffic" || pathname === "/events" || pathname === "/diagnostics";
}

export function MobileShell({ fixture }: MobileShellProps) {
  const { LL } = useI18nContext();
  const location = useLocation();
  const activity = isActivityPath(location.pathname);
  const diagnostics = location.pathname === "/events" && location.search.includes("diagnostics=1");
  const rules = location.pathname === "/traffic" && location.search.includes("tab=rules");

  return (
    <div className="mobile-shell" data-platform={fixture.platform}>
      <div className="mobile-chrome">
        <header className="mobile-top-app-bar">
          <img alt="" aria-hidden="true" src="/brand/mish-brand.svg" />
          <h1>{getTitle(LL, location.pathname)}</h1>
        </header>
        <div className="mobile-fixture-banner" role="status">
          <strong>{LL.mobileFixture.label()}</strong>
          <span>{LL.mobileFixture.unavailable()}</span>
        </div>
        {activity ? (
          <nav aria-label={LL.mobileNavigation.activity()} className="mobile-activity-navigation">
            <NavLink
              className={!rules && location.pathname === "/traffic" ? "is-active" : ""}
              to="/traffic?tab=active"
            >
              {LL.mobileNavigation.connections()}
            </NavLink>
            <NavLink className={rules ? "is-active" : ""} to="/traffic?tab=rules">
              {LL.mobileNavigation.rules()}
            </NavLink>
            <NavLink
              className={location.pathname === "/events" && !diagnostics ? "is-active" : ""}
              to="/events"
            >
              {LL.mobileNavigation.events()}
            </NavLink>
            <NavLink className={diagnostics ? "is-active" : ""} to="/events?diagnostics=1">
              {LL.mobileNavigation.diagnostics()}
            </NavLink>
          </nav>
        ) : null}
      </div>

      <main className="mobile-main">
        <Outlet />
      </main>

      <nav aria-label={LL.mobileNavigation.primary()} className="mobile-bottom-navigation">
        {destinations.map(({ icon: Icon, key, path }) => {
          const label = LL.mobileNavigation[key]();
          return (
            <NavLink
              aria-label={label}
              className={({ isActive }) => {
                const selected = key === "activity" ? activity : isActive;
                return `mobile-destination${selected ? " is-active" : ""}`;
              }}
              end={key !== "activity"}
              key={path}
              to={path}
            >
              <span className="mobile-destination-icon">
                <Icon
                  aria-hidden="true"
                  weight={key === "activity" && activity ? "fill" : "regular"}
                />
              </span>
              <span>{label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
