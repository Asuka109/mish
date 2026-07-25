import { Bell } from "@phosphor-icons/react/Bell";
import { X } from "@phosphor-icons/react/X";
import type { ApplicationActionId } from "@mish/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@mish/ui";
import { cx, tv } from "@mish/ui/tv";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useNavigate } from "react-router";
import { useCaptureCommand } from "../data/capture-command";
import { useNotificationDelivery, type DeliveredNotification } from "../data/notification-delivery";
import {
  dismissNotificationToast,
  presentNotificationToast,
} from "../data/sonner-notification-adapter";
import { useProduct } from "../data/product-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import {
  nativeSystemProxySettingsOpener,
  type SystemProxySettingsOpenOutcome,
  type SystemProxySettingsOpener,
} from "../platform/system-proxy-settings";
import { WelcomeDialog } from "./welcome-dialog";
import { NotificationPublicationController } from "./notification-publication-controller";

const visibleNotificationLimit = 5;

const notificationStyles = tv({
  slots: {
    trigger: cx(
      "toolbar-button notification-trigger relative inline-flex h-8.5 items-center justify-center",
      "gap-1.75 rounded-md border border-transparent bg-transparent px-2.25 text-metadata",
      "text-muted-foreground hover:border-hairline hover:bg-accent hover:text-fg",
      "data-popup-open:border-hairline data-popup-open:bg-accent data-popup-open:text-fg",
    ),
    count: cx(
      "notification-count absolute -top-1 -right-1.25 h-4.25 min-w-4.25 pointer-events-none px-1",
      "text-micro leading-none tabular-nums",
    ),
    popover: "notification-popover w-[min(360px,calc(100vw_-_24px))]",
    header:
      "notification-header flex items-start justify-between gap-3 px-3.5 pt-3.5 pb-3 [&_.ui-button]:flex-none",
    title: "notification-title text-body leading-5 font-semibold",
    description: "notification-description mt-0.5 text-metadata leading-4.5 text-muted-foreground",
    list: cx(
      "notification-list m-0 max-h-[min(360px,calc(100vh_-_180px))] list-none overflow-auto",
      "border-y border-hairline p-0",
    ),
    item: cx(
      "notification-item relative flex min-w-0 flex-col gap-1.25 px-3.5 pt-2.75 pb-3 [&+&]:border-t",
      "[&+&]:border-hairline-soft",
    ),
    itemHeading: cx(
      "notification-item-heading flex items-center justify-between gap-2 pr-6.5 [&_.ui-badge]:h-5",
      "[&_time]:text-caption [&_time]:text-muted-foreground",
    ),
    entryTitle: "notification-entry-title text-metadata font-medium text-ink",
    message:
      "notification-message cursor-text wrap-anywhere text-metadata leading-4.75 font-medium text-fg select-text",
    detail:
      "notification-detail mt-0.75 cursor-text wrap-anywhere text-metadata leading-4.5 text-muted-foreground select-text",
    remove: cx(
      "notification-remove absolute top-1.75 right-2 size-6.5 opacity-0 pointer-events-none",
      "transition-opacity duration-120 ease-out group-hover/item:opacity-100",
      "group-hover/item:pointer-events-auto focus-visible:opacity-100",
      "focus-visible:pointer-events-auto",
    ),
    actions: "notification-actions flex flex-wrap gap-1.5 pt-0.75",
    empty: "notification-empty min-h-42 rounded-none border-x-0 border-y border-hairline",
    footer: "notification-footer flex px-3.5 pt-2.5 pb-3",
    viewAll: "notification-view-all w-full",
  },
});

export function NotificationBubble({
  systemProxySettingsOpener = nativeSystemProxySettingsOpener,
}: {
  systemProxySettingsOpener?: SystemProxySettingsOpener;
}) {
  const notificationTriggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const settings = useOptionalSettings();
  const { commandStates, recoverSystemProxy, snapshot } = useProduct();
  const { setCapture } = useCaptureCommand();
  const { entries, markRead, remove, toastEntries } = useNotificationDelivery();
  const { LL, locale } = useI18nContext();
  const [open, setOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [pendingActions, setPendingActions] = useState<ReadonlyMap<string, ApplicationActionId>>(
    new Map(),
  );
  const [systemProxySettingsGuidance, setSystemProxySettingsGuidance] =
    useState<SystemProxySettingsGuidance | null>(null);
  const executingActions = useRef(new Set<string>());
  const presented = useRef<ReadonlyMap<string, string>>(new Map());

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const execute = useCallback(
    async (notificationId: string, actionId: ApplicationActionId) => {
      if (executingActions.current.has(notificationId)) return;
      const notification = entryById.get(notificationId);
      const action = notification?.actions.find(({ id }) => id === actionId);
      if (!notification || !action) return;
      executingActions.current.add(notificationId);
      const showPending =
        actionId !== "open-system-proxy-settings" &&
        actionId !== "show-system-proxy-settings-steps";
      if (showPending) {
        setPendingActions((current) => new Map(current).set(notificationId, actionId));
      }
      try {
        if (actionId === "repair") await recoverSystemProxy("repair");
        else if (actionId === "leave-as-is") await recoverSystemProxy("leave-as-is");
        else if (actionId === "find-ports-and-retry" && settings && snapshot) {
          if (!(await settings.findManagedPorts())) return;
          const selection =
            snapshot.runtime.captureSelection.systemProxy || snapshot.runtime.captureSelection.tun
              ? snapshot.runtime.captureSelection
              : { systemProxy: true, tun: false };
          await setCapture(selection, true);
        } else if (actionId === "open-welcome" && settings) {
          if (!(await settings.setOnboardingWelcomeState("open"))) return;
          dismissNotificationToast(notificationId);
          setWelcomeOpen(true);
        } else if (actionId === "open-diagnostics") {
          dismissNotificationToast(notificationId);
          setOpen(false);
          const query = new URLSearchParams({ diagnostics: "1" });
          if (action.diagnosticFailure) query.set("failure", action.diagnosticFailure);
          navigate(`/events?${query}`);
        } else if (actionId === "show-system-proxy-settings-steps") {
          setOpen(false);
          setSystemProxySettingsGuidance("manual");
        } else if (actionId === "open-system-proxy-settings") {
          let outcome: SystemProxySettingsOpenOutcome;
          try {
            outcome = await systemProxySettingsOpener.open();
          } catch {
            outcome = "dispatch-failed";
          }
          if (outcome !== "opened") {
            setOpen(false);
            setSystemProxySettingsGuidance(outcome);
          }
        }
      } finally {
        executingActions.current.delete(notificationId);
        if (showPending) {
          setPendingActions((current) => {
            const next = new Map(current);
            next.delete(notificationId);
            return next;
          });
        }
      }
    },
    [
      entryById,
      navigate,
      recoverSystemProxy,
      setCapture,
      settings,
      snapshot,
      systemProxySettingsOpener,
    ],
  );

  const removeNotification = useCallback(
    async (notificationId: string) => {
      const notification = entryById.get(notificationId);
      if (notification?.actions.some(({ id }) => id === "open-welcome")) {
        if (!settings || !(await settings.setOnboardingWelcomeState("remove"))) return;
      }
      remove(notificationId);
    },
    [entryById, remove, settings],
  );

  useEffect(() => {
    const nextPresented = new Map<string, string>();
    for (const notification of toastEntries) {
      const pendingActionId = pendingActions.get(notification.id);
      const presentedNotification = { ...notification, pendingActionId };
      const signature = JSON.stringify({
        actions: notification.actions.map(({ id }) => id),
        detail: notification.detail,
        level: notification.level,
        message: notification.message,
        pendingActionId,
        title: notification.title,
        toast: notification.toast,
      });
      nextPresented.set(notification.id, signature);
      if (notification.toast === "dismiss") {
        dismissNotificationToast(notification.id);
      } else if (
        notification.toast === "present" &&
        presented.current.get(notification.id) !== signature
      ) {
        presentNotificationToast(presentedNotification, (actionId) =>
          execute(notification.id, actionId),
        );
      }
    }
    for (const id of presented.current.keys()) {
      if (!nextPresented.has(id)) dismissNotificationToast(id);
    }
    presented.current = nextPresented;
  }, [execute, pendingActions, toastEntries]);

  const retainedNotifications = entries;
  const unreadCount = retainedNotifications.filter(({ read }) => !read).length;
  const visibleNotifications = retainedNotifications.slice(0, visibleNotificationLimit);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) markRead(retainedNotifications.map(({ id }) => id));
    setOpen(nextOpen);
  }

  return (
    <>
      <NotificationPublicationController />
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={LL.notifications.trigger({ count: unreadCount })}
              className={notificationStyles().trigger()}
              ref={notificationTriggerRef}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 ? (
            <Badge className={notificationStyles().count()} variant="destructive">
              {formatUnreadCount(unreadCount)}
            </Badge>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" className={notificationStyles().popover()} sideOffset={8}>
          <div className={notificationStyles().header()}>
            <div>
              <PopoverTitle className={notificationStyles().title()}>
                {LL.notifications.title()}
              </PopoverTitle>
              <PopoverDescription className={notificationStyles().description()}>
                {LL.notifications.description()}
              </PopoverDescription>
            </div>
          </div>
          {visibleNotifications.length > 0 ? (
            <ol className={notificationStyles().list()}>
              {visibleNotifications.map((notification) => (
                <NotificationItem
                  disabled={commandStates.capture.phase === "pending" || Boolean(settings?.pending)}
                  key={notification.id}
                  LL={LL}
                  locale={locale}
                  notification={{
                    ...notification,
                    pendingActionId: pendingActions.get(notification.id),
                  }}
                  onExecute={execute}
                  onRemove={removeNotification}
                />
              ))}
            </ol>
          ) : (
            <Empty className={notificationStyles().empty()}>
              <EmptyHeader>
                <EmptyTitle>{LL.notifications.emptyTitle()}</EmptyTitle>
                <EmptyDescription>{LL.notifications.emptyDescription()}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <div className={notificationStyles().footer()}>
            <Button
              className={notificationStyles().viewAll()}
              nativeButton={false}
              render={<Link onClick={() => setOpen(false)} to="/events" />}
              size="sm"
              variant="outline"
            >
              {LL.notifications.viewAllEvents()}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {settings ? (
        <WelcomeDialog
          onOpenChange={setWelcomeOpen}
          open={welcomeOpen}
          returnFocusRef={notificationTriggerRef}
        />
      ) : null}
      <SystemProxySettingsGuidanceDialog
        guidance={systemProxySettingsGuidance}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSystemProxySettingsGuidance(null);
        }}
        returnFocusRef={notificationTriggerRef}
      />
    </>
  );
}

type SystemProxySettingsGuidance = Exclude<SystemProxySettingsOpenOutcome, "opened"> | "manual";

interface SystemProxySettingsGuidanceDialogProps {
  guidance: SystemProxySettingsGuidance | null;
  onOpenChange(open: boolean): void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function SystemProxySettingsGuidanceDialog({
  guidance,
  onOpenChange,
  returnFocusRef,
}: SystemProxySettingsGuidanceDialogProps) {
  const { LL } = useI18nContext();
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const description =
    guidance === "unsupported-version"
      ? LL.capture.systemProxySettingsUnsupported()
      : guidance === "dispatch-failed"
        ? LL.capture.systemProxySettingsDispatchFailed()
        : LL.capture.systemProxySettingsManual();

  return (
    <Dialog onOpenChange={onOpenChange} open={guidance !== null}>
      <DialogContent
        closeLabel={LL.common.close()}
        finalFocus={returnFocusRef}
        initialFocus={acknowledgeRef}
      >
        <DialogHeader>
          <div>
            <DialogTitle>{LL.capture.systemProxySettingsManualTitle()}</DialogTitle>
            <DialogDescription className="cursor-text select-text" data-native-text-interaction>
              {description}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button ref={acknowledgeRef} variant="outline" />}>
            {LL.capture.acknowledge()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface NotificationItemProps {
  disabled: boolean;
  LL: TranslationFunctions;
  locale: Locales;
  notification: DeliveredNotification;
  onExecute(notificationId: string, actionId: ApplicationActionId): Promise<void>;
  onRemove(notificationId: string): Promise<void>;
}

function NotificationItem({
  disabled,
  LL,
  locale,
  notification,
  onExecute,
  onRemove,
}: NotificationItemProps) {
  return (
    <li className={notificationStyles().item({ className: "group/item" })}>
      {notification.removable ? (
        <Button
          aria-label={LL.notifications.remove({ message: notification.message })}
          className={notificationStyles().remove()}
          onClick={() => void onRemove(notification.id)}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
      <div className={notificationStyles().itemHeading()}>
        <Badge variant={levelBadge(notification.level)}>
          {LL.events.level[notification.level === "success" ? "info" : notification.level]()}
        </Badge>
        <time className="tabular-nums" dateTime={new Date(notification.observedAt).toISOString()}>
          {formatNotificationTime(notification.observedAt, locale)}
        </time>
      </div>
      {notification.title ? (
        <p className={notificationStyles().entryTitle()}>{notification.title}</p>
      ) : null}
      <p className={notificationStyles().message()} data-native-text-interaction>
        {notification.message}
      </p>
      {notification.detail ? (
        <p className={notificationStyles().detail()}>{notification.detail}</p>
      ) : null}
      {notification.actions.length > 0 ? (
        <div className={notificationStyles().actions()}>
          {notification.actions.map((action) => (
            <Button
              disabled={disabled || Boolean(notification.pendingActionId)}
              key={action.id}
              loading={notification.pendingActionId === action.id}
              loadingText={action.label}
              onClick={() => void onExecute(notification.id, action.id)}
              size="sm"
              variant="outline"
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function levelBadge(level: DeliveredNotification["level"]) {
  if (level === "error") return "destructive" as const;
  if (level === "warning") return "warning" as const;
  return "outline" as const;
}

function formatNotificationTime(value: number, locale: Locales) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value);
}

function formatUnreadCount(count: number) {
  return count > 99 ? "99+" : count;
}
