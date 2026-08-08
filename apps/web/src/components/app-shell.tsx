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
import { cx, tv } from "@mish/ui/tv";
import { useAppearance, type AppearancePreference } from "../appearance";
import { useCaptureCommand } from "../data/capture-command";
import { useCurrentProfileCommand } from "../data/current-profile-command";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
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
import { handleDesktopWindowDragOnly } from "../platform/desktop-window";
import { RouteFocusManager } from "../platform/route-focus";
import { NotificationBubble } from "./notification-bubble";
import { StatusShimmer } from "./status-shimmer";
import { SurfaceScope } from "./surface-scope";
import styles from "./app-shell.module.css";

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

const shellStyles = tv({
  slots: {
    root: cx(
      "app-shell relative grid h-screen h-dvh min-h-0 w-full grid-cols-[164px_minmax(0,1fr)]",
      "overflow-hidden bg-surface-soft max-shell-mobile:grid-cols-[minmax(0,1fr)]",
      "max-shell-mobile:grid-rows-[minmax(0,1fr)_auto]",
    ),
    sidebar: cx(
      "sidebar flex min-w-0 flex-col bg-sidebar-background px-2.5 pt-3.5 pb-2.5 text-fg",
      "@container/sidebar max-shell-mobile:grid max-shell-mobile:min-h-14",
      "max-shell-mobile:row-start-2 max-shell-mobile:grid-cols-[minmax(0,1fr)]",
      "max-shell-mobile:border-t max-shell-mobile:border-hairline max-shell-mobile:px-0",
      "max-shell-mobile:ps-[max(6px,env(safe-area-inset-left))]",
      "max-shell-mobile:pe-[max(6px,env(safe-area-inset-right))]",
      "max-shell-mobile:pt-1 max-shell-mobile:pb-[max(6px,env(safe-area-inset-bottom))]",
    ),
    sidebarHeader:
      "sidebar-window-header -mt-3.5 -mx-2.5 flex-none select-none pt-3.5 px-2.5 max-shell-mobile:hidden",
    windowControls: "window-controls-slot flex h-5.5 flex-none items-center select-none",
    trafficLights:
      "traffic-lights flex flex-none items-center gap-1.75 pl-1 runtime-desktop:invisible [&_svg]:size-3",
    brand:
      "brand-row flex h-12 items-center px-2 font-semibold text-ink [&_img]:h-7.5 [&_img]:w-auto [&_img]:max-w-full",
    brandLight: "brand-image-light theme-dark:hidden",
    brandDark: "brand-image-dark hidden theme-dark:block",
    navList: cx(
      "nav-list flex min-h-0 flex-1 flex-col gap-0.75 pt-1.75 max-shell-mobile:grid",
      "max-shell-mobile:grid-cols-7 max-shell-mobile:gap-0 max-shell-mobile:p-0",
    ),
    navItem: cx(
      "nav-item grid h-sidebar-row-height w-full flex-none",
      "grid-cols-[var(--spacing-sidebar-icon)_minmax(0,1fr)] items-center gap-x-sidebar-row-gap",
      "rounded-md border border-transparent px-sidebar-row-inset text-body font-medium",
      "text-muted-foreground no-underline hover:bg-sidebar-item-hover hover:text-fg",
      "max-shell-mobile:h-11 max-shell-mobile:grid-cols-1 max-shell-mobile:grid-rows-[18px_12px]",
      "max-shell-mobile:content-center max-shell-mobile:justify-items-center max-shell-mobile:gap-0",
      "max-shell-mobile:px-0 max-shell-mobile:text-micro",
      "max-shell-mobile:leading-3 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis",
      "[&>span]:whitespace-nowrap max-shell-mobile:[&>span]:col-start-1",
      "max-shell-mobile:[&>span]:row-start-2 max-shell-mobile:[&>span]:block",
      "max-shell-mobile:[&>span]:max-w-full [&_svg]:col-start-1 [&_svg]:size-sidebar-icon",
      "[&_svg]:justify-self-center max-shell-mobile:[&_svg]:row-start-1",
    ),
    sidebarBottom: "sidebar-bottom-items mt-auto flex flex-col gap-0.75 max-shell-mobile:contents",
    workspace: cx(
      "workspace relative grid min-h-0 min-w-0 grid-rows-[56px_minmax(0,1fr)] overflow-hidden",
      "m-2.5 ml-0 rounded-lg border border-hairline bg-canvas shadow-panel",
      "max-shell-mobile:row-start-1 max-shell-mobile:mx-1.5 max-shell-mobile:mt-1.5",
      "max-shell-mobile:mb-0 max-shell-mobile:rounded-compact",
    ),
    toolbar: cx(
      "toolbar flex min-w-0 items-center justify-between border-b border-hairline py-0 pr-4 pl-6",
      "select-none max-toolbar-compact:pl-4.5 max-shell-mobile:py-0 max-shell-mobile:pr-2",
      "max-shell-mobile:pl-3",
    ),
    toolbarTitle: cx(
      "toolbar-title font-medium max-shell-mobile:min-w-0 max-shell-mobile:overflow-hidden",
      "max-shell-mobile:text-ellipsis max-shell-mobile:whitespace-nowrap",
    ),
    toolbarHeading: "toolbar-heading flex min-w-0 items-center gap-2",
    toolbarActions: cx(
      "toolbar-actions flex min-w-0 flex-initial items-center gap-1.5 max-shell-mobile:flex-none",
      "max-shell-mobile:gap-0.5",
    ),
    profileTrigger: cx(
      "profile-select-trigger h-8.5 min-w-28 max-w-55 bg-transparent max-shell-mobile:w-8.5",
      "max-shell-mobile:min-w-8.5 max-shell-mobile:p-0 max-shell-mobile:[&>span]:hidden",
      "[&>.user-authored-label]:min-w-0 [&>.user-authored-label]:overflow-hidden",
      "[&>.user-authored-label]:text-ellipsis [&>.user-authored-label]:whitespace-nowrap",
    ),
    menuContent: "min-w-39",
    menuLabel:
      "profile-menu-label block px-2.25 pt-1.5 pb-1.75 text-metadata text-muted-foreground",
    runtimeBadge: cx(
      "runtime-data-badge inline-flex h-6 items-center justify-center gap-1.75 rounded-md border",
      "border-hairline bg-surface-soft px-2.25 text-caption text-muted-foreground",
      "max-toolbar-compact:hidden",
    ),
    loading: "toolbar-loading text-metadata text-muted-foreground max-shell-mobile:hidden",
    contentScroll: "workspace-page-scroll min-h-0 min-w-0 overflow-auto",
  },
  variants: {
    active: {
      true: {
        navItem:
          "is-active border-sidebar-item-active-border bg-sidebar-item-active text-ink shadow-sidebar-item-active",
      },
      false: {},
    },
  },
});

export const proxyControlStyles = tv({
  slots: {
    proxyControl: cx(
      "proxy-control-button relative flex h-sidebar-row-height w-full items-center overflow-hidden",
      "rounded-md border border-transparent bg-transparent p-0 text-left text-metadata font-medium",
      "text-muted-foreground isolate disabled:opacity-100 max-shell-mobile:h-11",
      "max-shell-mobile:text-micro max-shell-mobile:leading-3",
      "[&:not([data-status=healthy]):hover]:bg-sidebar-item-hover",
      "[&:not([data-status=healthy]):hover]:text-fg",
    ),
    material: "pointer-events-none absolute inset-0 z-0 rounded-material-inset",
    state: cx(
      "proxy-control-state relative z-2 grid w-full min-w-0",
      "grid-cols-[var(--spacing-sidebar-icon)_minmax(0,1fr)] items-center gap-x-sidebar-row-gap",
      "px-sidebar-row-inset transition-opacity duration-160 ease-proxy-crossfade",
      "max-shell-mobile:grid-cols-1 max-shell-mobile:grid-rows-[18px_12px]",
      "max-shell-mobile:content-center max-shell-mobile:justify-items-center max-shell-mobile:gap-0",
      "max-shell-mobile:px-0 [&>:first-child]:col-start-1",
      "max-shell-mobile:[&>:first-child]:row-start-1",
      "[&>:first-child]:justify-self-center [&_svg]:size-sidebar-icon",
    ),
    defaultState: "proxy-control-default",
    hoverState: "proxy-control-hover absolute inset-0 opacity-0",
    label: cx(
      "proxy-control-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
      "max-shell-mobile:col-start-1 max-shell-mobile:row-start-2 max-shell-mobile:max-w-full",
    ),
  },
  variants: {
    healthy: {
      true: {
        proxyControl: cx(
          "border-status-water-border bg-status-water-base text-brand-foreground shadow-status",
          "hover:border-status-water-border hover:bg-status-water-base hover:text-brand-foreground",
          "focus-visible:border-status-water-border focus-visible:bg-status-water-base",
          "focus-visible:text-brand-foreground",
          "[&:is(:hover,:focus-visible)_[data-slot=proxy-control-default]]:opacity-0",
          "[&:is(:hover,:focus-visible)_[data-slot=proxy-control-hover]]:opacity-100",
        ),
      },
      false: {},
    },
  },
});

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
  const proxyStyles = proxyControlStyles({ healthy: phase === "healthy" });

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
      className={proxyStyles.proxyControl()}
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
          className={proxyStyles.material({ className: styles.proxyControlMaterial })}
          data-slot="proxy-control-material"
        >
          <StatusShimmer active />
        </span>
      ) : null}
      {pending ? (
        <span
          className={proxyStyles.state({ className: proxyStyles.defaultState() })}
          data-slot="proxy-control-default"
        >
          <Spinner data-icon="inline-start" />
          <span className={proxyStyles.label()}>{LL.common.pending()}</span>
        </span>
      ) : needsAttention ? (
        <span
          className={proxyStyles.state({ className: proxyStyles.defaultState() })}
          data-slot="proxy-control-default"
        >
          <XCircle aria-hidden="true" data-icon="inline-start" />
          <span className={proxyStyles.label()}>{LL.proxyControl.needsAttention()}</span>
        </span>
      ) : active ? (
        <>
          <span
            className={proxyStyles.state({ className: proxyStyles.defaultState() })}
            data-slot="proxy-control-default"
          >
            <WifiHigh aria-hidden="true" data-icon="inline-start" weight="bold" />
            <span className={proxyStyles.label()}>{LL.proxyControl.running()}</span>
          </span>
          <span
            aria-hidden="true"
            className={proxyStyles.state({ className: proxyStyles.hoverState() })}
            data-slot="proxy-control-hover"
          >
            <XCircle data-icon="inline-start" />
            <span className={proxyStyles.label()}>{LL.proxyControl.disable()}</span>
          </span>
        </>
      ) : (
        <span
          className={proxyStyles.state({ className: proxyStyles.defaultState() })}
          data-slot="proxy-control-default"
        >
          <Power aria-hidden="true" data-icon="inline-start" />
          <span className={proxyStyles.label()}>{LL.proxyControl.enable()}</span>
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
      className={shellStyles().sidebar()}
      data-window-drag-behavior="drag-only"
      data-window-drag-surface="sidebar"
      onMouseDown={handleDesktopWindowDragOnly}
      surfaceRole="window"
    >
      <div className={shellStyles().sidebarHeader()}>
        <div className={shellStyles().windowControls()}>
          <div aria-hidden="true" className={shellStyles().trafficLights()}>
            <Circle color="#ff5f57" weight="fill" />
            <Circle color="#febc2e" weight="fill" />
            <Circle color="#28c840" weight="fill" />
          </div>
        </div>
        <div aria-label="Mish" className={shellStyles().brand()}>
          <img
            alt=""
            aria-hidden="true"
            className={shellStyles().brandLight()}
            draggable={false}
            src="/brand/mish-brand.svg"
          />
          <img
            alt=""
            aria-hidden="true"
            className={shellStyles().brandDark()}
            draggable={false}
            src="/brand/mish-brand-dark.svg"
          />
        </div>
      </div>

      <nav
        aria-label={LL.navigation.sections()}
        className={shellStyles().navList()}
        onKeyDown={handleSidebarKeyDown}
      >
        {destinations.map(({ icon: Icon, key, path }) => (
          <NavLink
            aria-label={getNavigationLabel(LL, key)}
            className={({ isActive }) => shellStyles({ active: isActive }).navItem()}
            end
            key={path}
            title={getNavigationLabel(LL, key)}
            to={path}
          >
            <Icon aria-hidden="true" />
            <span>{getNavigationLabel(LL, key)}</span>
          </NavLink>
        ))}
        <div className={shellStyles().sidebarBottom()}>
          <NavLink
            aria-label={LL.navigation.settings()}
            className={({ isActive }) =>
              shellStyles({ active: isActive }).navItem({ className: "settings-link" })
            }
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
      <span className={shellStyles().loading()}>
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
        publish(
          notificationPublication("profile.switch-failed", {
            severity: "error",
          }),
        );
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
        className={shellStyles().profileTrigger()}
        disabled={profilePending || !profileSupported || managedProfiles.length === 0}
        touchTarget="adaptive"
      >
        {profilePending ? <Spinner data-icon="inline-start" /> : <FileText aria-hidden="true" />}
        <span className="user-authored-label">{activeLabel}</span>
      </SelectTrigger>
      <SelectContent align="end" className="profile-menu" sideOffset={8}>
        <SelectGroup>
          {managedProfiles.map((profile) => (
            <SelectItem
              className={cx(
                "profile-menu-item relative flex min-h-8.5 grid-cols-none items-center gap-2",
                "rounded-sm px-2.25 text-metadata text-fg outline-none select-none",
                "data-highlighted:bg-accent data-highlighted:text-ink",
              )}
              key={profile.id}
              value={profile.id}
            >
              <span className="user-authored-label">{profile.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function LanguageMenu() {
  const { LL, locale } = useI18nContext();
  const settings = useOptionalSettings();
  const [pending, setPending] = useState(false);
  const currentLanguage = locale === "zh" ? LL.language.simplifiedChinese() : LL.language.english();

  async function changeLocale(value: string) {
    if (!isLocale(value)) return;
    setPending(true);
    try {
      if (settings && !(await settings.setLanguage(value === "zh" ? "zh-CN" : "en"))) return;
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-busy={pending}
            aria-label={LL.language.current({ language: currentLanguage })}
            className="language-menu-trigger"
            disabled={pending}
            size="icon"
            touchTarget="adaptive"
            variant="toolbar"
          />
        }
      >
        {pending ? <Spinner data-icon="icon-only" /> : <Translate aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="language-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={(value) => void changeLocale(value)} value={locale}>
          <DropdownMenuLabel className={shellStyles().menuLabel()}>
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
        render={
          <Button
            aria-busy={appearancePending}
            aria-label={LL.appearance.current({ appearance: currentAppearance })}
            className="appearance-menu-trigger"
            disabled={appearancePending}
            size="icon"
            touchTarget="adaptive"
            variant="toolbar"
          />
        }
      >
        {appearancePending ? <Spinner /> : <AppearanceIcon aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={shellStyles().menuContent()} sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={changeAppearance} value={preference}>
          <DropdownMenuLabel className={shellStyles().menuLabel()}>
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
    <header className={shellStyles().toolbar()}>
      <div className={shellStyles().toolbarHeading()}>
        <span className={shellStyles().toolbarTitle()}>{title}</span>
        {runtimeBadge ? (
          <Tooltip>
            <TooltipTrigger className={shellStyles().runtimeBadge()}>
              {runtimeBadge.label}
            </TooltipTrigger>
            <TooltipContent>{runtimeBadge.description}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className={shellStyles().toolbarActions()}>
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
    <div className={shellStyles().root()}>
      <StatusActionDescriptions />
      <Sidebar />
      <SurfaceScope as="main" className={shellStyles().workspace()} surfaceRole="content">
        <RouteFocusManager />
        <Toolbar />
        <div className={shellStyles().contentScroll()}>
          <Outlet />
        </div>
      </SurfaceScope>
    </div>
  );
}
