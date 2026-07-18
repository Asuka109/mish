import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Circle } from "@phosphor-icons/react/Circle";
import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { Gauge } from "@phosphor-icons/react/Gauge";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ListBullets } from "@phosphor-icons/react/ListBullets";
import { Moon } from "@phosphor-icons/react/Moon";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import { Power } from "@phosphor-icons/react/Power";
import { Stack } from "@phosphor-icons/react/Stack";
import { Sun } from "@phosphor-icons/react/Sun";
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
} from "@mish/ui";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAppearance, type AppearancePreference } from "../appearance";
import { useProduct } from "../data/product-provider";
import {
  getAggregateCaptureDescriptionId,
  getCommandDescriptionId,
  isCaptureCapabilityAvailable,
  statusDescriptionIds,
} from "../data/status-capabilities";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import { isLocale } from "../i18n/i18n-util";
import { persistLocale } from "../i18n/locale";
import { handleDesktopWindowDrag } from "../platform/desktop-window";
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
  return "Mish";
}

const languageOptions: Array<{ label: "english" | "simplifiedChinese"; value: Locales }> = [
  { label: "english", value: "en" },
  { label: "simplifiedChinese", value: "zh" },
];

const appearanceOptions: AppearancePreference[] = ["system", "light", "dark"];

function ProxyControlButton() {
  const { isCommandPending, isCommandSupported, setCapture, snapshot } = useProduct();
  const { LL } = useI18nContext();
  const runtime = snapshot?.runtime;
  const active = runtime ? runtime.systemProxyEnabled || runtime.tunEnabled : false;
  const pending = isCommandPending("capture");
  const commandSupported = isCommandSupported("capture");
  const systemProxyAvailable = snapshot
    ? isCaptureCapabilityAvailable(snapshot.adapterKind, snapshot.capabilities.systemProxy)
    : false;
  const tunAvailable = snapshot
    ? isCaptureCapabilityAvailable(snapshot.adapterKind, snapshot.capabilities.tun)
    : false;
  const captureAvailable = systemProxyAvailable || tunAvailable;
  const phase = pending ? (active ? "stopping" : "connecting") : (runtime?.phase ?? "inactive");
  const selectedCapture = {
    systemProxy: Boolean(runtime?.captureSelection.systemProxy && systemProxyAvailable),
    tun: Boolean(runtime?.captureSelection.tun && tunAvailable),
  };
  const resumeSelection =
    selectedCapture.systemProxy || selectedCapture.tun
      ? selectedCapture
      : { systemProxy: systemProxyAvailable, tun: !systemProxyAvailable && tunAvailable };
  const resumeModes = [
    resumeSelection.systemProxy ? LL.capture.systemProxy() : null,
    resumeSelection.tun ? LL.capture.tun() : null,
  ].filter((mode) => mode !== null);
  const resumeDescription = LL.proxyControl.enableWithModes({ modes: resumeModes.join(" + ") });
  const fixture = snapshot?.adapterKind === "fixture";
  const actionDescriptionId = snapshot
    ? getAggregateCaptureDescriptionId(snapshot, commandSupported)
    : undefined;

  async function handleToggle() {
    if (!runtime) return;
    if (active) {
      await setCapture(runtime.captureSelection, false);
      return;
    }

    await setCapture(resumeSelection, true);
  }

  return (
    <button
      aria-describedby={actionDescriptionId}
      aria-label={
        active
          ? fixture
            ? LL.proxyControl.disableFixtureAria()
            : LL.proxyControl.disableAria()
          : fixture
            ? LL.proxyControl.enableFixtureAria()
            : LL.proxyControl.enableAria()
      }
      className="proxy-control-button"
      data-status={phase}
      disabled={!snapshot || pending || !commandSupported || !captureAvailable}
      onClick={handleToggle}
      title={active ? LL.proxyControl.disable() : resumeDescription}
      type="button"
    >
      {phase === "healthy" ? <StatusShimmer active /> : null}
      {pending ? (
        <span className="proxy-control-state proxy-control-default">
          <Power aria-hidden="true" />
          <span className="proxy-control-label">{LL.common.pending()}</span>
        </span>
      ) : active ? (
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
      <div className="sidebar-window-header" data-tauri-drag-region="deep">
        <div className="window-controls-slot">
          <div aria-hidden="true" className="traffic-lights">
            <Circle color="#ff5f57" weight="fill" />
            <Circle color="#febc2e" weight="fill" />
            <Circle color="#28c840" weight="fill" />
          </div>
          <div aria-hidden="true" className="window-drag-region" />
        </div>
        <div aria-label="Mish" className="brand-row">
          <Stack aria-hidden="true" />
          <span>Mish</span>
        </div>
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
  const { connection, isCommandPending, isCommandSupported, setActiveProfile, snapshot } =
    useProduct();
  const { LL } = useI18nContext();
  if (!snapshot) {
    return (
      <span className="toolbar-loading">
        {connection.phase === "fixture" ? LL.toolbar.loadingFixture() : LL.toolbar.loadingDesktop()}
      </span>
    );
  }

  const activeProfile =
    snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId) ??
    snapshot.profiles[0];
  if (!activeProfile) return <span className="toolbar-loading">{LL.common.unavailable()}</span>;

  const profilePending = isCommandPending("profile");
  const profileSupported = isCommandSupported("profile");
  const actionDescriptionId = getCommandDescriptionId(snapshot.adapterKind, profileSupported);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-describedby={actionDescriptionId}
        aria-label={LL.toolbar.switchProfile({ profile: activeProfile.label })}
        className="toolbar-button profile-menu-trigger"
        disabled={profilePending || !profileSupported || snapshot.profiles.length < 2}
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
              disabled={profilePending}
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

function AppearanceMenu() {
  const { preference, resolvedAppearance, setPreference } = useAppearance();
  const { LL } = useI18nContext();
  const currentAppearance = LL.appearance[preference]();
  const AppearanceIcon = resolvedAppearance === "dark" ? Moon : Sun;

  function changeAppearance(value: string) {
    if (!appearanceOptions.includes(value as AppearancePreference)) return;
    setPreference(value as AppearancePreference);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={LL.appearance.current({ appearance: currentAppearance })}
        className="toolbar-button appearance-menu-trigger"
      >
        <AppearanceIcon aria-hidden="true" />
        <CaretDown aria-hidden="true" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="appearance-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={changeAppearance} value={preference}>
          <DropdownMenuLabel className="profile-menu-label">
            {LL.appearance.label()}
          </DropdownMenuLabel>
          {appearanceOptions.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {LL.appearance[option]()}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Toolbar() {
  const location = useLocation();
  const { snapshot } = useProduct();
  const { LL } = useI18nContext();
  const title = getPageTitle(LL, location.pathname);
  const runtimeBadge =
    snapshot?.adapterKind === "fixture"
      ? { description: LL.toolbar.demoDescription(), label: LL.toolbar.demoMode() }
      : snapshot?.adapterKind === "rpc"
        ? { description: LL.toolbar.localServiceDescription(), label: LL.toolbar.localService() }
        : snapshot?.adapterKind === "native"
          ? { description: LL.toolbar.deviceDescription(), label: LL.toolbar.deviceMode() }
          : null;

  return (
    <header className="toolbar" onMouseDown={handleDesktopWindowDrag}>
      <span className="toolbar-title">{title}</span>
      <div className="toolbar-actions">
        {runtimeBadge ? (
          <Tooltip>
            <TooltipTrigger className="runtime-data-badge">{runtimeBadge.label}</TooltipTrigger>
            <TooltipContent>{runtimeBadge.description}</TooltipContent>
          </Tooltip>
        ) : null}
        <AppearanceMenu />
        <LanguageMenu />
        <ProfileMenu />
      </div>
    </header>
  );
}

function StatusActionDescriptions() {
  const { snapshot } = useProduct();
  const { LL } = useI18nContext();
  if (!snapshot) return null;

  if (snapshot.adapterKind === "fixture") {
    return (
      <span className="sr-only" id={statusDescriptionIds.fixtureAction}>
        {LL.toolbar.fixtureActionDescription()}
      </span>
    );
  }

  return (
    <div className="sr-only">
      <span id={statusDescriptionIds.localActionUnavailable}>
        {LL.capabilities.localActionUnavailable()}
      </span>
      <span id={statusDescriptionIds.captureUnavailable}>
        {LL.capabilities.captureUnavailable()}
      </span>
      <span id={statusDescriptionIds.capturePermission}>{LL.capabilities.capturePermission()}</span>
      <span id={statusDescriptionIds.systemProxyUnavailable}>
        {LL.capabilities.systemProxyUnavailable()}
      </span>
      <span id={statusDescriptionIds.systemProxyPermission}>
        {LL.capabilities.systemProxyPermission()}
      </span>
      <span id={statusDescriptionIds.tunUnavailable}>{LL.capabilities.tunUnavailable()}</span>
      <span id={statusDescriptionIds.tunPermission}>{LL.capabilities.tunPermission()}</span>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="app-shell">
      <StatusActionDescriptions />
      <Sidebar />
      <main className="workspace">
        <Toolbar />
        <Outlet />
      </main>
    </div>
  );
}
