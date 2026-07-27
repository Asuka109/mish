import type { MobileFixtureBootstrapDto } from "@mish/contracts";
import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { House } from "@phosphor-icons/react/House";
import { Pulse } from "@phosphor-icons/react/Pulse";
import { NavLink, Outlet, useLocation } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import { RouteFocusManager } from "../platform/route-focus";

const destinations = [
  { icon: House, key: "home", path: "/status" },
  { icon: CirclesFour, key: "routes", path: "/routes" },
  { icon: FileText, key: "profiles", path: "/profiles" },
  { icon: Pulse, key: "activity", path: "/traffic" },
  { icon: GearSix, key: "settings", path: "/settings" },
] as const;

const mobileShellStyles = tv({
  slots: {
    root: cx(
      "mobile-shell grid h-full min-h-0 w-full min-w-0",
      "grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-canvas",
    ),
    chrome: "mobile-chrome z-10 border-b border-hairline bg-canvas",
    topBar: cx(
      "mobile-top-app-bar flex min-h-[calc(56px+env(safe-area-inset-top))] items-center gap-2.75",
      "px-4 pt-[env(safe-area-inset-top)] [&_img]:size-7",
    ),
    brandLight: "brand-image-light theme-dark:hidden",
    brandDark: "brand-image-dark hidden theme-dark:block",
    title: "text-title leading-7 font-semibold",
    activityNavigation:
      "mobile-activity-navigation flex min-w-0 gap-1 overflow-x-auto px-3 pb-2.5 scrollbar-none",
    activityLink: cx(
      "inline-flex min-h-11 min-w-max items-center rounded-full px-3 text-metadata font-medium",
      "text-muted-foreground no-underline",
    ),
    main: "mobile-main min-h-0 min-w-0 overflow-hidden bg-canvas [&>*]:h-full",
    bottomNavigation: cx(
      "mobile-bottom-navigation z-10 grid min-h-[calc(64px+env(safe-area-inset-bottom))]",
      "grid-cols-5 border-t border-hairline bg-surface-soft px-1 pt-1",
      "pb-[env(safe-area-inset-bottom)]",
    ),
    destination: cx(
      "mobile-destination flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5",
      "rounded-md text-label-small leading-3.5 font-medium text-muted-foreground no-underline",
    ),
    destinationIcon:
      "mobile-destination-icon grid h-7.5 w-13.5 place-items-center rounded-full [&_svg]:size-5.5",
  },
  variants: {
    selected: {
      true: {
        activityLink: "is-active bg-accent text-ink",
        destination: "is-active text-ink",
        destinationIcon: "bg-accent text-brand",
      },
      false: {},
    },
  },
});

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
    <div className={mobileShellStyles().root()} data-platform={fixture.platform}>
      <RouteFocusManager
        headingSelector=".mobile-top-app-bar h1"
        scrollerSelector="main .mobile-home-page"
      />
      <div className={mobileShellStyles().chrome()}>
        <header className={mobileShellStyles().topBar()}>
          <img
            alt=""
            aria-hidden="true"
            className={mobileShellStyles().brandLight()}
            draggable={false}
            src="/brand/mish-icon-outline.svg"
          />
          <img
            alt=""
            aria-hidden="true"
            className={mobileShellStyles().brandDark()}
            draggable={false}
            src="/brand/mish-icon-outline-dark.svg"
          />
          <h1 className={mobileShellStyles().title()}>{getTitle(LL, location.pathname)}</h1>
        </header>
        {activity ? (
          <nav
            aria-label={LL.mobileNavigation.activity()}
            className={mobileShellStyles().activityNavigation()}
          >
            <NavLink
              aria-current={!rules && location.pathname === "/traffic" ? "page" : undefined}
              className={mobileShellStyles({
                selected: !rules && location.pathname === "/traffic",
              }).activityLink()}
              to="/traffic?tab=active"
            >
              {LL.mobileNavigation.connections()}
            </NavLink>
            <NavLink
              aria-current={rules ? "page" : undefined}
              className={mobileShellStyles({ selected: rules }).activityLink()}
              to="/traffic?tab=rules"
            >
              {LL.mobileNavigation.rules()}
            </NavLink>
            <NavLink
              aria-current={location.pathname === "/events" && !diagnostics ? "page" : undefined}
              className={mobileShellStyles({
                selected: location.pathname === "/events" && !diagnostics,
              }).activityLink()}
              to="/events"
            >
              {LL.mobileNavigation.events()}
            </NavLink>
            <NavLink
              aria-current={diagnostics ? "page" : undefined}
              className={mobileShellStyles({ selected: diagnostics }).activityLink()}
              to="/events?diagnostics=1"
            >
              {LL.mobileNavigation.diagnostics()}
            </NavLink>
          </nav>
        ) : null}
      </div>

      <main className={mobileShellStyles().main()}>
        <Outlet />
      </main>

      <nav
        aria-label={LL.mobileNavigation.primary()}
        className={mobileShellStyles().bottomNavigation()}
      >
        {destinations.map(({ icon: Icon, key, path }) => {
          const label = LL.mobileNavigation[key]();
          const selected = key === "activity" ? activity : location.pathname === path;
          return (
            <NavLink
              aria-current={selected ? "page" : undefined}
              aria-label={label}
              className={mobileShellStyles({ selected }).destination()}
              end={key !== "activity"}
              key={path}
              to={path}
            >
              <span className={mobileShellStyles({ selected }).destinationIcon()}>
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
