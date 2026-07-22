import { Circle } from "@phosphor-icons/react/Circle";
import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { Gauge } from "@phosphor-icons/react/Gauge";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ListBullets } from "@phosphor-icons/react/ListBullets";
import { Moon } from "@phosphor-icons/react/Moon";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import { Power } from "@phosphor-icons/react/Power";
import { Sun } from "@phosphor-icons/react/Sun";
import { Translate } from "@phosphor-icons/react/Translate";
import { WifiHigh } from "@phosphor-icons/react/WifiHigh";
import { XCircle } from "@phosphor-icons/react/XCircle";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mish/ui";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAppearance, type AppearancePreference } from "../appearance";
import { useCaptureCommand } from "../data/capture-command";
import { useCurrentProfileCommand } from "../data/current-profile-command";
import { useNotificationDelivery } from "../data/notification-delivery";
import { useProduct } from "../data/product-provider";
import { useOptionalProfiles } from "../data/profile-provider";
import { useOptionalSettings } from "../data/settings-provider";
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
import { RouteFocusManager } from "../platform/route-focus";
import { NotificationBubble } from "./notification-bubble";
import { StatusShimmer } from "./status-shimmer";
import { SurfaceScope } from "./surface-scope";

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

function handleSidebarKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !(event.target instanceof Element)
  ) {
    return;
  }

  const current = event.target.closest<HTMLAnchorElement>(".nav-item[href]");
  if (!current) return;
  const destinations = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>(".nav-item[href]"),
  );
  const currentIndex = destinations.indexOf(current);
  if (currentIndex < 0) return;

  let next: HTMLAnchorElement | undefined;
  if (event.key === "ArrowDown") {
    next = destinations[(currentIndex + 1) % destinations.length];
  } else if (event.key === "ArrowUp") {
    next = destinations[(currentIndex - 1 + destinations.length) % destinations.length];
  } else if (event.key === "Home") {
    next = destinations[0];
  } else if (event.key === "End") {
    next = destinations.at(-1);
  } else if (event.key.length === 1 && event.key.trim()) {
    const prefix = event.key.toLocaleLowerCase();
    const ordered = destinations
      .slice(currentIndex + 1)
      .concat(destinations.slice(0, currentIndex + 1));
    next = ordered.find((destination) =>
      destination.textContent?.trim().toLocaleLowerCase().startsWith(prefix),
    );
  }

  if (!next) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
}

function ProxyControlButton() {
  const { isCommandSupported, snapshot } = useProduct();
  const { pending, setCapture } = useCaptureCommand();
  const { LL } = useI18nContext();
  const runtime = snapshot?.runtime;
  const active = runtime ? runtime.systemProxyEnabled || runtime.tunEnabled : false;
  const commandSupported = isCommandSupported("capture");
  const systemProxyAvailable = snapshot
    ? isCaptureCapabilityAvailable(snapshot.adapterKind, snapshot.capabilities.systemProxy)
    : false;
  const tunAvailable = snapshot
    ? isCaptureCapabilityAvailable(snapshot.adapterKind, snapshot.capabilities.tun)
    : false;
  const captureAvailable = systemProxyAvailable || tunAvailable;
  const needsAttention =
    runtime?.systemProxy.phase === "drift" ||
    (runtime?.systemProxy.phase === "failed" && runtime.systemProxy.failure !== "core-unhealthy");
  const phase = pending
    ? active
      ? "stopping"
      : "connecting"
    : needsAttention
      ? "error"
      : active
        ? (runtime?.phase ?? "inactive")
        : "inactive";
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
    <Button
      aria-busy={pending}
      aria-describedby={actionDescriptionId}
      aria-label={
        needsAttention
          ? LL.proxyControl.needsAttention()
          : active
            ? fixture
              ? LL.proxyControl.disableFixtureAria()
              : LL.proxyControl.disableAria()
            : fixture
              ? LL.proxyControl.enableFixtureAria()
              : LL.proxyControl.enableAria()
      }
      className="proxy-control-button"
      data-status={phase}
      disabled={!snapshot || pending || needsAttention || !commandSupported || !captureAvailable}
      onClick={handleToggle}
      variant="ghost"
      title={
        needsAttention
          ? LL.proxyControl.needsAttention()
          : active
            ? LL.proxyControl.disable()
            : resumeDescription
      }
      type="button"
    >
      {phase === "healthy" ? (
        <span
          aria-hidden="true"
          className="proxy-control-material"
          data-slot="proxy-control-material"
        >
          <StatusShimmer active />
        </span>
      ) : null}
      {pending ? (
        <span className="proxy-control-state proxy-control-default">
          <Spinner data-icon="inline-start" />
          <span className="proxy-control-label">{LL.common.pending()}</span>
        </span>
      ) : needsAttention ? (
        <span className="proxy-control-state proxy-control-default">
          <XCircle aria-hidden="true" data-icon="inline-start" />
          <span className="proxy-control-label">{LL.proxyControl.needsAttention()}</span>
        </span>
      ) : active ? (
        <>
          <span className="proxy-control-state proxy-control-default">
            <WifiHigh aria-hidden="true" data-icon="inline-start" weight="bold" />
            <span className="proxy-control-label">{LL.proxyControl.running()}</span>
          </span>
          <span aria-hidden="true" className="proxy-control-state proxy-control-hover">
            <XCircle data-icon="inline-start" />
            <span className="proxy-control-label">{LL.proxyControl.disable()}</span>
          </span>
        </>
      ) : (
        <span className="proxy-control-state proxy-control-default">
          <Power aria-hidden="true" data-icon="inline-start" />
          <span className="proxy-control-label">{LL.proxyControl.enable()}</span>
        </span>
      )}
    </Button>
  );
}

function Sidebar() {
  const { LL } = useI18nContext();

  return (
    <SurfaceScope
      aria-label={LL.navigation.primary()}
      as="aside"
      className="sidebar"
      surfaceRole="window"
    >
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
          <img
            alt=""
            aria-hidden="true"
            className="brand-image-light"
            draggable={false}
            src="/brand/mish-brand.svg"
          />
          <img
            alt=""
            aria-hidden="true"
            className="brand-image-dark"
            draggable={false}
            src="/brand/mish-brand-dark.svg"
          />
        </div>
      </div>

      <nav
        aria-label={LL.navigation.sections()}
        className="nav-list"
        onKeyDown={handleSidebarKeyDown}
      >
        {destinations.map(({ icon: Icon, key, path }) => (
          <NavLink
            aria-label={getNavigationLabel(LL, key)}
            className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`}
            end
            key={path}
            title={getNavigationLabel(LL, key)}
            to={path}
          >
            <Icon aria-hidden="true" />
            <span>{getNavigationLabel(LL, key)}</span>
          </NavLink>
        ))}
        <div className="sidebar-bottom-items">
          <NavLink
            aria-label={LL.navigation.settings()}
            className={({ isActive }) => `nav-item settings-link${isActive ? " is-active" : ""}`}
            title={LL.navigation.settings()}
            to="/settings"
          >
            <GearSix aria-hidden="true" />
            <span>{LL.navigation.settings()}</span>
          </NavLink>
          <ProxyControlButton />
        </div>
      </nav>
    </SurfaceScope>
  );
}

function ProfileMenu() {
  const { connection, isCommandPending, isCommandSupported, setActiveProfile, snapshot } =
    useProduct();
  const profiles = useOptionalProfiles();
  const { pending: currentProfilePending, selectCurrentProfile } = useCurrentProfileCommand();
  const { LL } = useI18nContext();
  const { publish } = useNotificationDelivery();
  if (!snapshot) {
    return (
      <span className="toolbar-loading">
        {connection.phase === "fixture" ? LL.toolbar.loadingFixture() : LL.toolbar.loadingDesktop()}
      </span>
    );
  }

  const fixtureSelectionSupported =
    snapshot.adapterKind === "fixture" && isCommandSupported("profile");
  const savedProfiles = profiles?.snapshot?.profiles ?? [];
  const useSavedProfiles =
    snapshot.adapterKind === "rpc" &&
    profiles?.snapshot?.adapterKind === "rpc" &&
    profiles?.connection.phase === "connected" &&
    !profiles.connection.stale;
  const managedProfiles = useSavedProfiles ? savedProfiles : snapshot.profiles;
  const selectedProfileId = useSavedProfiles
    ? profiles?.selectedProfileId
    : snapshot.activeProfileId;
  const selectedProfile = managedProfiles.find((profile) => profile.id === selectedProfileId);
  const statusProfile = snapshot.profiles.find(
    (profile) => profile.id === snapshot.activeProfileId,
  );
  const displayedProfile = useSavedProfiles
    ? (selectedProfile ?? (savedProfiles.length === 1 ? savedProfiles[0] : undefined))
    : (selectedProfile ?? statusProfile);
  const activeLabel =
    displayedProfile?.label ??
    (useSavedProfiles && managedProfiles.length === 0
      ? LL.profiles.emptyLabel()
      : LL.profiles.safeStopped());

  const profilePending = useSavedProfiles ? currentProfilePending : isCommandPending("profile");
  const profileSupported = useSavedProfiles || fixtureSelectionSupported;
  const actionDescriptionId = getCommandDescriptionId(snapshot.adapterKind, profileSupported);

  async function selectProfile(profileId: string) {
    if (useSavedProfiles) {
      const result = await selectCurrentProfile(profileId);
      if (!result.ok) {
        publish({
          id: "profiles-switch-failed",
          level: "error",
          message: LL.profiles.switchFailed(),
        });
      }
    } else if (fixtureSelectionSupported) {
      await setActiveProfile(profileId);
    }
  }

  return (
    <Select
      onValueChange={(profileId) =>
        typeof profileId === "string" ? void selectProfile(profileId) : undefined
      }
      value={selectedProfile?.id ?? ""}
    >
      <SelectTrigger
        aria-busy={profilePending}
        aria-describedby={actionDescriptionId}
        aria-label={LL.toolbar.switchProfile({ profile: activeLabel })}
        className="profile-select-trigger"
        disabled={profilePending || !profileSupported || managedProfiles.length === 0}
      >
        {profilePending ? <Spinner data-icon="inline-start" /> : <FileText aria-hidden="true" />}
        <span className="user-authored-label">{activeLabel}</span>
      </SelectTrigger>
      <SelectContent align="end" className="profile-menu" sideOffset={8}>
        <SelectGroup>
          {managedProfiles.map((profile) => (
            <SelectItem className="profile-menu-item" key={profile.id} value={profile.id}>
              <span className="user-authored-label">{profile.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function LanguageMenu() {
  const { LL, locale, setLocale } = useI18nContext();
  const settings = useOptionalSettings();
  const [pending, setPending] = useState(false);
  const currentLanguage = locale === "zh" ? LL.language.simplifiedChinese() : LL.language.english();

  async function changeLocale(value: string) {
    if (!isLocale(value)) return;
    setPending(true);
    try {
      if (settings && !(await settings.setLanguage(value))) return;
      persistLocale(value);
      setLocale(value);
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-busy={pending}
        aria-label={LL.language.current({ language: currentLanguage })}
        className="toolbar-button language-menu-trigger"
        disabled={pending}
      >
        {pending ? <Spinner data-icon="icon-only" /> : <Translate aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="language-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={(value) => void changeLocale(value)} value={locale}>
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
  const { appearancePending, preference, resolvedAppearance, setPreference } = useAppearance();
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
        aria-busy={appearancePending}
        aria-label={LL.appearance.current({ appearance: currentAppearance })}
        className="toolbar-button appearance-menu-trigger"
        disabled={appearancePending}
      >
        {appearancePending ? <Spinner /> : <AppearanceIcon aria-hidden="true" />}
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
      : null;

  return (
    <header className="toolbar" onMouseDown={handleDesktopWindowDrag}>
      <div className="toolbar-heading">
        <span className="toolbar-title">{title}</span>
        {runtimeBadge ? (
          <Tooltip>
            <TooltipTrigger className="runtime-data-badge">{runtimeBadge.label}</TooltipTrigger>
            <TooltipContent>{runtimeBadge.description}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="toolbar-actions">
        <ProfileMenu />
        <AppearanceMenu />
        <LanguageMenu />
        <NotificationBubble />
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
      <div
        aria-hidden="true"
        className="workspace-top-window-drag-region"
        data-window-drag-surface="workspace-top"
        onMouseDown={handleDesktopWindowDrag}
      />
      <Sidebar />
      <SurfaceScope as="main" className="workspace" surfaceRole="content">
        <RouteFocusManager />
        <Toolbar />
        <div className="workspace-page-scroll">
          <Outlet />
        </div>
      </SurfaceScope>
    </div>
  );
}
