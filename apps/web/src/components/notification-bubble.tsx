import { Bell } from "@phosphor-icons/react/Bell";
import {
  Badge,
  Button,
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
import type { EventLevel, EventRecordDto } from "@mish/contracts";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useOptionalEvents } from "../data/events-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";

const visibleNotificationLimit = 5;
const noEvents: EventRecordDto[] = [];

interface ReadNotificationState {
  eventIds: Set<string>;
  sessionId: string | null;
}

export function NotificationBubble() {
  const eventsContext = useOptionalEvents();
  const { LL, locale } = useI18nContext();
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<ReadNotificationState>({
    eventIds: new Set(),
    sessionId: null,
  });
  const events = eventsContext?.events ?? noEvents;
  const sessionId = eventsContext?.snapshot?.sessionId ?? null;
  const importantEvents = useMemo(
    () =>
      events
        .filter((event) => event.level === "warning" || event.level === "error")
        .toSorted((left, right) => right.sequence - left.sequence),
    [events],
  );
  const readEventIds = readState.sessionId === sessionId ? readState.eventIds : new Set<string>();
  const unreadCount = importantEvents.filter((event) => !readEventIds.has(event.id)).length;
  const visibleEvents = importantEvents.slice(0, visibleNotificationLimit);

  function markAllRead() {
    setReadState({
      eventIds: new Set(importantEvents.map(({ id }) => id)),
      sessionId,
    });
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={LL.notifications.trigger({ count: unreadCount })}
            className="toolbar-button notification-trigger"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Bell aria-hidden="true" />
        {unreadCount > 0 ? (
          <Badge className="notification-count tabular" variant="destructive">
            {formatUnreadCount(unreadCount)}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="notification-popover" sideOffset={8}>
        <div className="notification-header">
          <div>
            <PopoverTitle className="notification-title">{LL.notifications.title()}</PopoverTitle>
            <PopoverDescription className="notification-description">
              {LL.notifications.description()}
            </PopoverDescription>
          </div>
          <Button disabled={unreadCount === 0} onClick={markAllRead} size="sm" variant="ghost">
            {LL.notifications.markAllRead()}
          </Button>
        </div>

        {visibleEvents.length > 0 ? (
          <ol className="notification-list">
            {visibleEvents.map((event) => (
              <NotificationItem event={event} key={event.id} LL={LL} locale={locale} />
            ))}
          </ol>
        ) : (
          <Empty className="notification-empty">
            <EmptyHeader>
              <EmptyTitle>{LL.notifications.emptyTitle()}</EmptyTitle>
              <EmptyDescription>{LL.notifications.emptyDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <div className="notification-footer">
          <Button
            className="notification-view-all"
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
  );
}

interface NotificationItemProps {
  event: EventRecordDto;
  LL: TranslationFunctions;
  locale: Locales;
}

function NotificationItem({ event, LL, locale }: NotificationItemProps) {
  return (
    <li className="notification-item">
      <div className="notification-item-heading">
        <Badge variant={levelBadge(event.level)}>{LL.events.level[event.level]()}</Badge>
        <time className="tabular" dateTime={new Date(event.observedAt).toISOString()}>
          {formatNotificationTime(event.observedAt, locale)}
        </time>
      </div>
      <p>{event.message}</p>
      <span>{LL.events.source[event.source]()}</span>
    </li>
  );
}

function levelBadge(level: EventLevel) {
  if (level === "error") return "destructive" as const;
  if (level === "warning") return "warning" as const;
  return "outline" as const;
}

function formatNotificationTime(value: number, locale: Locales) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatUnreadCount(count: number) {
  return count > 99 ? "99+" : count;
}
