import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Circle } from "@phosphor-icons/react/Circle";
import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { Gauge } from "@phosphor-icons/react/Gauge";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ListBullets } from "@phosphor-icons/react/ListBullets";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import { Power } from "@phosphor-icons/react/Power";
import { Stack } from "@phosphor-icons/react/Stack";
import { Translate } from "@phosphor-icons/react/Translate";
import { WifiHigh } from "@phosphor-icons/react/WifiHigh";
import { XCircle } from "@phosphor-icons/react/XCircle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mihomo/ui";
import { NavLink, Outlet, useLocation } from "react-router";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import { isLocale } from "../i18n/i18n-util";
import { persistLocale } from "../i18n/locale";
import { StatusShimmer } from "./status-shimmer";

const destinations = [
  { icon: Gauge, key: "status", path: "/status" },
  { icon: CirclesFour, key: "routes", path: "/routes" },
  { icon: FileText, key: "profiles", path: "/profiles" },
  { icon: PlugsConnected, key: "traffic", path: "/traffic" },
  { icon: ListBullets, key: "events", path: "/events" },
] as const;

function getNavigationLabel(LL: TranslationFunctions, key: (typeof destinations)[number]["key"]) {
  return LL.navigation[key]();
}

function getPageTitle(LL: TranslationFunctions, pathname: string) {
  const title = destinations.find((destination) => destination.path === pathname);
  if (title) return getNavigationLabel(LL, title.key);
  if (pathname === "/settings") return LL.navigation.settings();
  return "Mihomo";
}

const languageOptions: Array<{ label: "english" | "simplifiedChinese"; value: Locales }> = [
  { label: "english", value: "en" },
  { label: "simplifiedChinese", value: "zh" },
];

function ProxyControlButton() {
  const { setCapture, snapshot } = useProduct();
  const { LL } = useI18nContext();
  const runtime = snapshot?.runtime;
  const active = runtime ? runtime.systemProxyEnabled || runtime.tunEnabled : false;
  const phase = runtime?.phase ?? "inactive";

  async function handleToggle() {
    if (!runtime) return;
    if (active) {
      await setCapture(false, false);
      return;
    }

    await setCapture(true, false);
  }

  return (
    <button
      aria-describedby="fixture-action-description"
      aria-label={active ? LL.proxyControl.disableAria() : LL.proxyControl.enableAria()}
      className="proxy-control-button"
      data-status={phase}
      disabled={!snapshot}
      onClick={handleToggle}
      type="button"
    >
      {phase === "healthy" ? <StatusShimmer active /> : null}
      {active ? (
        <>
          <span className="proxy-control-state proxy-control-default">
            <WifiHigh aria-hidden="true" weight="bold" />
            <span className="proxy-control-label">{LL.proxyControl.running()}</span>
          </span>
          <span aria-hidden="true" className="proxy-control-state proxy-control-hover">
            <XCircle />
            <span className="proxy-control-label">{LL.proxyControl.disable()}</span>
          </span>
        </>
      ) : (
        <span className="proxy-control-state proxy-control-default">
          <Power aria-hidden="true" />
          <span className="proxy-control-label">{LL.proxyControl.enable()}</span>
        </span>
      )}
    </button>
  );
}

function Sidebar() {
  const { LL } = useI18nContext();

  return (
    <aside aria-label={LL.navigation.primary()} className="sidebar">
      <div aria-hidden="true" className="traffic-lights">
        <Circle color="#ff5f57" weight="fill" />
        <Circle color="#febc2e" weight="fill" />
        <Circle color="#28c840" weight="fill" />
      </div>
      <div aria-label="Mihomo" className="brand-row">
        <Stack aria-hidden="true" />
        <span>Mihomo</span>
      </div>

      <nav aria-label={LL.navigation.sections()} className="nav-list">
        {destinations.map(({ icon: Icon, key, path }) => (
          <NavLink
            className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`}
            end
            key={path}
            to={path}
          >
            <Icon aria-hidden="true" />
            <span>{getNavigationLabel(LL, key)}</span>
          </NavLink>
        ))}
        <NavLink
          className={({ isActive }) => `nav-item settings-link${isActive ? " is-active" : ""}`}
          to="/settings"
        >
          <GearSix aria-hidden="true" />
          <span>{LL.navigation.settings()}</span>
        </NavLink>
      </nav>

      <div className="sidebar-status-area">
        <ProxyControlButton />
      </div>
    </aside>
  );
}

function ProfileMenu() {
  const { setActiveProfile, snapshot } = useProduct();
  const { LL } = useI18nContext();
  if (!snapshot) return <span className="toolbar-loading">{LL.toolbar.loadingFixture()}</span>;

  const activeProfile =
    snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId) ??
    snapshot.profiles[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={LL.toolbar.switchProfile({ profile: activeProfile.label })}
        className="toolbar-button profile-menu-trigger"
      >
        <FileText aria-hidden="true" />
        <span className="user-authored-label">{activeProfile.label}</span>
        <CaretDown aria-hidden="true" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="profile-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={setActiveProfile} value={activeProfile.id}>
          <DropdownMenuLabel className="profile-menu-label">
            {LL.toolbar.profiles()}
          </DropdownMenuLabel>
          {snapshot.profiles.map((profile) => (
            <DropdownMenuRadioItem
              className="profile-menu-item"
              key={profile.id}
              value={profile.id}
            >
              <span className="user-authored-label">{profile.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LanguageMenu() {
  const { LL, locale, setLocale } = useI18nContext();
  const currentLanguage = locale === "zh" ? LL.language.simplifiedChinese() : LL.language.english();

  function changeLocale(value: string) {
    if (!isLocale(value)) return;
    persistLocale(value);
    setLocale(value);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={LL.language.current({ language: currentLanguage })}
        className="toolbar-button language-menu-trigger"
      >
        <Translate aria-hidden="true" />
        <span>{locale === "zh" ? "中" : "EN"}</span>
        <CaretDown aria-hidden="true" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="language-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={changeLocale} value={locale}>
          <DropdownMenuLabel className="profile-menu-label">
            {LL.language.label()}
          </DropdownMenuLabel>
          {languageOptions.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {LL.language[option.label]()}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Toolbar() {
  const location = useLocation();
  const { LL } = useI18nContext();
  const title = getPageTitle(LL, location.pathname);

  return (
    <header className="toolbar">
      <span className="toolbar-title">{title}</span>
      <div className="toolbar-actions">
        <Tooltip>
          <TooltipTrigger className="demo-data-badge">{LL.toolbar.demoMode()}</TooltipTrigger>
          <TooltipContent>{LL.toolbar.demoDescription()}</TooltipContent>
        </Tooltip>
        <LanguageMenu />
        <ProfileMenu />
      </div>
      <span className="sr-only" id="fixture-action-description">
        {LL.toolbar.fixtureActionDescription()}
      </span>
    </header>
  );
}

export function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        <Toolbar />
        <Outlet />
      </main>
    </div>
  );
}
