import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { Check } from "@phosphor-icons/react/Check";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { SortAscending } from "@phosphor-icons/react/SortAscending";
import { XCircle } from "@phosphor-icons/react/XCircle";
import type { GroupDelayChildResultDto, PolicyGroupDto, ProxyNodeDto } from "@mish/contracts";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "@mish/ui";
import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import { normalizeMeasuredLatency, POLICY_ENTITY_BATCH_SIZE } from "../pages/routes-model";

/**
 * `status` gives the Status host a compact, readable five-row rhythm. It
 * deliberately relaxes to the normal row rhythm when the Status columns stack,
 * so localized labels can use the available vertical space without clipping.
 */
export type PolicyBrowserDensity = "default" | "compact" | "status";
export type PolicyEntityKind = "node" | "group";
export type PolicySelectionState = "current" | "pending" | "unselected" | "read-only";
export type PolicyLatencyState = "measured" | "unknown" | "testing" | "failed" | "cancelled";

const policyGroupSummaryRecipe = tv({
  base: cx(
    "policy-browser-group-summary grid w-full min-w-0 items-center justify-stretch gap-2.5",
    "rounded-none border-0 bg-transparent text-left text-fg",
    "[&>.ui-badge]:shrink-0 [&>svg]:size-3.25 [&>svg]:text-muted-soft",
  ),
  variants: {
    density: {
      compact: "policy-browser-group-summary--compact min-h-11 px-2.5 py-1.5",
      default: "policy-browser-group-summary--default min-h-14.5 px-3 py-2",
      status: cx(
        "policy-browser-group-summary--status min-h-12.5 px-2.5 py-1",
        "max-page-compact:min-h-14.5 max-page-compact:px-3 max-page-compact:py-2",
      ),
    },
    interactive: {
      false: "policy-browser-group-summary--static",
      true: "policy-browser-group-summary--interactive hover:bg-accent hover:text-ink focus-visible:bg-accent focus-visible:text-ink",
    },
    ranked: {
      false: "grid-cols-[minmax(0,1fr)_auto_auto]",
      true: "grid-cols-[20px_minmax(0,1fr)_auto_auto]",
    },
  },
  defaultVariants: { density: "default", interactive: true, ranked: false },
});

const policyEntityRowRecipe = tv({
  base: cx(
    "policy-browser-entity-row grid min-w-0 grid-cols-[minmax(0,1fr)_auto] bg-canvas",
    "[&_.policy-browser-entity-primary]:grid [&_.policy-browser-entity-primary]:h-auto",
    "[&_.policy-browser-entity-primary]:w-full [&_.policy-browser-entity-primary]:min-w-0",
    "[&_.policy-browser-entity-primary]:grid-cols-[minmax(0,1fr)_auto]",
    "[&_.policy-browser-entity-primary]:items-center [&_.policy-browser-entity-primary]:justify-stretch",
    "[&_.policy-browser-entity-primary]:gap-4 [&_.policy-browser-entity-primary]:rounded-none",
    "[&_.policy-browser-entity-primary]:border-0 [&_.policy-browser-entity-primary]:bg-transparent",
    "[&_.policy-browser-entity-primary]:text-left [&_.policy-browser-entity-primary]:text-fg",
    "max-shell-mobile:[&_.policy-browser-entity-primary]:grid-cols-1",
    "max-shell-mobile:[&_.policy-browser-entity-primary]:gap-1",
  ),
  variants: {
    density: {
      compact: cx(
        "policy-browser-entity-row--compact [&_.policy-browser-entity-primary]:min-h-11",
        "[&_.policy-browser-entity-primary]:px-2.5 [&_.policy-browser-entity-primary]:py-1.5",
        "[&_.policy-browser-entity-primary]:pl-4",
      ),
      default: cx(
        "policy-browser-entity-row--default [&_.policy-browser-entity-primary]:min-h-13",
        "[&_.policy-browser-entity-primary]:py-1.75 [&_.policy-browser-entity-primary]:pr-3",
        "[&_.policy-browser-entity-primary]:pl-11",
      ),
      status: cx(
        "policy-browser-entity-row--status [&_.policy-browser-entity-primary]:min-h-12.5",
        "[&_.policy-browser-entity-primary]:px-2.5 [&_.policy-browser-entity-primary]:py-1",
        "[&_.policy-browser-entity-primary]:pl-4",
        "max-page-compact:[&_.policy-browser-entity-primary]:min-h-13",
        "max-page-compact:[&_.policy-browser-entity-primary]:py-1.75",
        "max-page-compact:[&_.policy-browser-entity-primary]:pr-3",
        "max-page-compact:[&_.policy-browser-entity-primary]:pl-11",
      ),
    },
    disabled: {
      false: "",
      true: cx(
        "policy-browser-entity-row--disabled opacity-55",
        "[&_.policy-browser-entity-primary:disabled]:opacity-100",
        "[&_.policy-browser-latency]:text-muted-foreground",
        "[&_.policy-browser-selection]:text-muted-foreground",
      ),
    },
    entityKind: {
      group: "policy-browser-entity-row--group",
      node: "policy-browser-entity-row--node",
    },
    interactive: {
      false: "policy-browser-entity-row--static",
      true: cx(
        "policy-browser-entity-row--interactive",
        "[&_.policy-browser-entity-primary:hover]:bg-accent",
        "[&_.policy-browser-entity-primary:hover]:text-ink",
        "[&_.policy-browser-entity-primary:focus-visible]:bg-accent",
        "[&_.policy-browser-entity-primary:focus-visible]:text-ink",
      ),
    },
    selectionState: {
      current: "policy-browser-entity-row--current bg-accent",
      pending: "policy-browser-entity-row--pending bg-accent",
      "read-only":
        "policy-browser-entity-row--read-only [&_.policy-browser-entity-primary]:text-muted-foreground",
      unselected: "policy-browser-entity-row--unselected",
    },
  },
  defaultVariants: {
    density: "default",
    disabled: false,
    entityKind: "node",
    interactive: true,
    selectionState: "unselected",
  },
});

const latencyStatusRecipe = tv({
  base: cx(
    "policy-browser-latency grid min-w-19 text-right text-metadata text-muted-foreground tabular-nums",
    "[&_time]:text-micro [&_time]:text-muted-soft max-shell-mobile:min-w-0",
    "max-shell-mobile:text-left",
  ),
  variants: {
    latencyState: {
      cancelled: "policy-browser-latency--cancelled text-error",
      failed: "policy-browser-latency--failed text-error",
      measured: "policy-browser-latency--measured text-success-text",
      testing: "policy-browser-latency--testing",
      unknown: "policy-browser-latency--unknown",
    },
  },
  defaultVariants: { latencyState: "unknown" },
});

const selectionStatusRecipe = tv({
  base: cx(
    "policy-browser-selection inline-flex items-center gap-1.25 text-caption",
    "text-muted-foreground whitespace-nowrap [&_svg]:size-3.25",
  ),
  variants: {
    selectionState: {
      current: "policy-browser-selection--current text-success-text",
      pending: "policy-browser-selection--pending text-warning",
      "read-only": "policy-browser-selection--read-only",
      unselected: "policy-browser-selection--unselected",
    },
  },
});

function policyRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-policy-row-primary]:not(:disabled)"),
  );
}

export function handlePolicyPeerNavigation(event: ReactKeyboardEvent<HTMLElement>) {
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
  const current = event.target.closest<HTMLElement>("[data-policy-row-primary]");
  if (!current) return;
  const rows = policyRows(event.currentTarget);
  const currentIndex = rows.indexOf(current);
  if (currentIndex < 0) return;
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = rows[Math.min(currentIndex + 1, rows.length - 1)];
  else if (event.key === "ArrowUp") next = rows[Math.max(currentIndex - 1, 0)];
  else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows.at(-1);
  if (!next || next === current) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}

function delayState(result?: GroupDelayChildResultDto): PolicyLatencyState | null {
  if (!result) return null;
  if (result.phase === "pending") return "testing";
  if (result.phase === "cancelled") return "cancelled";
  if (result.phase === "failed") return "failed";
  return "measured";
}

export interface LatencyStatusProps {
  cancelledLabel: string;
  failureLabel(result: GroupDelayChildResultDto): string;
  latencyMilliseconds?: number | null;
  measuredLabel(latency: number): string;
  result?: GroupDelayChildResultDto;
  testingLabel: string;
}

export function LatencyStatus({
  cancelledLabel,
  failureLabel,
  latencyMilliseconds,
  measuredLabel,
  result,
  testingLabel,
}: LatencyStatusProps) {
  const historical = normalizeMeasuredLatency(latencyMilliseconds);
  const state = delayState(result) ?? (historical === null ? "unknown" : "measured");
  const latency =
    result?.phase === "success" ? normalizeMeasuredLatency(result.latencyMilliseconds) : historical;
  if (state === "unknown" || (state === "measured" && latency === null)) return null;
  const label =
    state === "testing"
      ? testingLabel
      : state === "cancelled"
        ? cancelledLabel
        : state === "failed" && result
          ? failureLabel(result)
          : measuredLabel(latency!);
  return (
    <span className={latencyStatusRecipe({ latencyState: state })} data-latency-state={state}>
      <span>{label}</span>
      {result?.observedAt === null || result?.observedAt === undefined ? null : (
        <time dateTime={new Date(result.observedAt).toISOString()}>
          {new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(result.observedAt)}
        </time>
      )}
    </span>
  );
}

export interface SelectionStatusProps {
  currentLabel: string;
  pendingLabel: string;
  readOnlyLabel: string;
  state: PolicySelectionState;
}

export function SelectionStatus({
  currentLabel,
  pendingLabel,
  readOnlyLabel,
  state,
}: SelectionStatusProps) {
  if (state === "unselected") return null;
  return (
    <span className={selectionStatusRecipe({ selectionState: state })}>
      {state === "pending" ? <Spinner data-icon="inline-start" /> : <Check aria-hidden="true" />}
      {state === "pending" ? pendingLabel : state === "read-only" ? readOnlyLabel : currentLabel}
    </span>
  );
}

interface PolicyGroupSummaryRowProps {
  childCount: number;
  childCountLabel: string;
  currentLabel: string;
  density?: PolicyBrowserDensity;
  group: PolicyGroupDto;
  latency?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  pending?: boolean;
  rank?: number;
  typeLabel?: string;
}

export function PolicyGroupSummaryRow({
  childCount,
  childCountLabel,
  currentLabel,
  density = "default",
  group,
  latency,
  onOpen,
  openLabel,
  pending = false,
  rank,
  typeLabel,
}: PolicyGroupSummaryRowProps) {
  const content = (
    <>
      {rank === undefined ? null : (
        <span className="policy-browser-rank text-center text-caption text-muted-soft tabular-nums">
          {rank}
        </span>
      )}
      <span className="policy-browser-summary-copy grid min-w-0 gap-0.5">
        <span className="policy-browser-summary-title-line flex min-w-0 items-center gap-2 [&_.ui-badge]:h-5 [&_.ui-badge]:shrink-0 [&_.ui-badge]:rounded-sm [&_.ui-badge]:bg-transparent [&_.ui-badge]:font-normal">
          <strong
            className="user-authored-label min-w-0 truncate text-body font-medium"
            title={group.label}
          >
            {group.label}
          </strong>
          {typeLabel ? <Badge variant="outline">{typeLabel}</Badge> : null}
        </span>
        <span className="policy-browser-summary-current user-authored-label truncate text-metadata text-muted-foreground">
          {currentLabel}
          {latency}
        </span>
      </span>
      <Badge aria-label={childCountLabel} variant="outline">
        {childCount}
      </Badge>
      {onOpen ? <CaretRight aria-hidden="true" /> : null}
    </>
  );
  if (!onOpen) {
    return (
      <div
        className={policyGroupSummaryRecipe({
          density,
          interactive: false,
          ranked: rank !== undefined,
        })}
        data-policy-browser-density={density}
      >
        {content}
      </div>
    );
  }
  return (
    <Button
      aria-label={openLabel}
      aria-busy={pending || undefined}
      className={policyGroupSummaryRecipe({
        density,
        interactive: true,
        ranked: rank !== undefined,
      })}
      data-policy-browser-density={density}
      data-policy-row-primary
      onClick={onOpen}
      type="button"
      variant="ghost"
    >
      {content}
    </Button>
  );
}

interface PolicyEntityRowProps {
  automaticLabel?: string;
  browseLabel?: string;
  browseTo?: string;
  currentLabel: string;
  density?: PolicyBrowserDensity;
  disabled?: boolean;
  entity: PolicyGroupDto | ProxyNodeDto;
  entityKind: PolicyEntityKind;
  latency: ReactNode;
  metadata: string;
  muted?: boolean;
  onBrowse?: () => void;
  onSelect?: () => void;
  pendingLabel: string;
  readOnlyPresentation?: "explicit" | "passive";
  readOnlyLabel: string;
  selectLabel?: string;
  selected: boolean;
  selectionPending: boolean;
}

export function PolicyEntityRow({
  automaticLabel,
  browseLabel,
  browseTo,
  currentLabel,
  density = "default",
  disabled = false,
  entity,
  entityKind,
  latency,
  metadata,
  muted = false,
  onBrowse,
  onSelect,
  pendingLabel,
  readOnlyPresentation = "explicit",
  readOnlyLabel,
  selectLabel,
  selected,
  selectionPending,
}: PolicyEntityRowProps) {
  const automaticGroup =
    entityKind === "group" &&
    "type" in entity &&
    (entity.type === "url-test" || entity.type === "fallback" || entity.type === "load-balance");
  const selectionState: PolicySelectionState = selectionPending
    ? "pending"
    : selected
      ? "current"
      : onSelect
        ? "unselected"
        : "read-only";
  const visualSelectionState =
    (muted && selectionState === "current") ||
    (readOnlyPresentation === "passive" && selectionState === "read-only")
      ? "unselected"
      : selectionState;
  const content = (
    <>
      <span className="policy-browser-entity-copy grid min-w-0 gap-0.5 [&>*]:min-w-0">
        <span className="flex items-center gap-2">
          <strong className="user-authored-label min-w-0 truncate font-medium" title={entity.label}>
            {entity.label}
          </strong>
          {automaticGroup && automaticLabel ? (
            <Badge className="h-5 shrink-0 rounded-sm bg-transparent font-normal" variant="outline">
              {automaticLabel}
            </Badge>
          ) : null}
        </span>
        <span className="text-metadata text-muted-foreground">{metadata}</span>
      </span>
      <span className="policy-browser-entity-status inline-flex min-w-0 items-center justify-end gap-3 max-shell-mobile:justify-between">
        {selectionState === "read-only" &&
        (automaticGroup || readOnlyPresentation === "passive") ? null : (
          <SelectionStatus
            currentLabel={currentLabel}
            pendingLabel={pendingLabel}
            readOnlyLabel={readOnlyLabel}
            state={selectionState}
          />
        )}
        {latency}
      </span>
    </>
  );
  return (
    <div
      className={policyEntityRowRecipe({
        density,
        disabled: muted,
        entityKind,
        interactive: Boolean(onSelect),
        selectionState: visualSelectionState,
      })}
      data-disabled={disabled || undefined}
      data-entity-id={entity.id}
      data-muted={muted || undefined}
    >
      {onSelect ? (
        <Button
          aria-label={selectLabel}
          aria-busy={selectionPending || undefined}
          aria-pressed={selected}
          className="policy-browser-entity-primary"
          data-policy-row-primary
          disabled={disabled || selectionPending}
          onClick={onSelect}
          type="button"
          variant="ghost"
        >
          {content}
        </Button>
      ) : (
        <div className="policy-browser-entity-primary policy-browser-entity-primary--static">
          {content}
        </div>
      )}
      {browseTo ? (
        <Link
          aria-label={browseLabel}
          className="policy-browser-browse grid min-h-11 w-11 min-w-11 place-items-center self-stretch rounded-none border-0 border-l border-hairline-soft bg-transparent text-muted-foreground no-underline touch-manipulation hover:bg-accent hover:text-ink focus-visible:bg-accent focus-visible:text-ink"
          to={browseTo}
        >
          <CaretRight aria-hidden="true" />
        </Link>
      ) : onBrowse ? (
        <Button
          aria-label={browseLabel}
          className="policy-browser-browse grid min-h-11 w-11 min-w-11 place-items-center self-stretch rounded-none border-0 border-l border-hairline-soft bg-transparent text-muted-foreground touch-manipulation hover:bg-accent hover:text-ink focus-visible:bg-accent focus-visible:text-ink"
          onClick={onBrowse}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <CaretRight aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

interface PolicyBrowserToolbarProps<Sort extends string> {
  cancelAriaLabel: string;
  cancelLabel: string;
  delayActive: boolean;
  delayBusy: boolean;
  delayDisabled: boolean;
  delayProgress: ReactNode;
  mobile?: boolean;
  onCancel(): void;
  onQueryChange(query: string): void;
  onSortChange(sort: Sort): void;
  onTest(): void;
  query: string;
  searchLabel: string;
  searchPlaceholder: string;
  showSearch?: boolean;
  sort: Sort;
  sortDisabled?: boolean;
  sortLabel: string;
  sorts: readonly Sort[];
  sortOptionLabel(sort: Sort): string;
  testLabel: string;
  testAriaLabel: string;
}

export function PolicyBrowserToolbar<Sort extends string>({
  cancelAriaLabel,
  cancelLabel,
  delayActive,
  delayBusy,
  delayDisabled,
  delayProgress,
  mobile = false,
  onCancel,
  onQueryChange,
  onSortChange,
  onTest,
  query,
  searchLabel,
  searchPlaceholder,
  showSearch = true,
  sort,
  sortDisabled = false,
  sortLabel,
  sorts,
  sortOptionLabel,
  testLabel,
  testAriaLabel,
}: PolicyBrowserToolbarProps<Sort>) {
  const searchId = useId();
  const sortItems = sorts.map((option) => ({ label: sortOptionLabel(option), value: option }));
  return (
    <div
      className={
        mobile
          ? "mobile-policy-browser-toolbar grid min-w-0 grid-cols-1 gap-3"
          : "policy-browser-toolbar grid min-w-0 grid-cols-[minmax(180px,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-hairline-soft bg-surface-soft px-3 py-2.5 max-shell-mobile:grid-cols-1"
      }
    >
      {showSearch ? (
        <Field className="policy-browser-search-field min-w-0">
          <FieldLabel className="sr-only" htmlFor={searchId}>
            {searchLabel}
          </FieldLabel>
          <span className="policy-browser-search-control relative flex items-center [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-2.75 [&>svg]:size-4 [&>svg]:text-muted-foreground [&_.ui-input]:pl-8.5">
            <MagnifyingGlass aria-hidden="true" />
            <Input
              aria-label={searchLabel}
              autoComplete="off"
              data-native-search
              id={searchId}
              name="policy-group-search"
              onValueChange={onQueryChange}
              placeholder={searchPlaceholder}
              spellCheck={false}
              type="search"
              value={query}
              className={mobile ? "min-h-11 text-body" : undefined}
            />
          </span>
        </Field>
      ) : null}
      <div
        className={cx(
          mobile
            ? "mobile-policy-browser-toolbar-actions flex min-w-0 items-center justify-between gap-2"
            : "policy-browser-toolbar-actions flex items-center justify-end gap-2 max-shell-mobile:col-start-1 max-shell-mobile:row-auto max-shell-mobile:justify-between",
          !mobile && !showSearch && "col-start-2 row-start-1",
        )}
      >
        <Select
          disabled={sortDisabled}
          items={sortItems}
          onValueChange={(next) => {
            if (typeof next === "string" && sorts.includes(next as Sort)) {
              onSortChange(next as Sort);
            }
          }}
          value={sort}
        >
          <SelectTrigger
            aria-label={sortLabel}
            className={cx(
              "policy-browser-sort h-8.5 min-w-37 max-w-44 flex-none max-shell-mobile:min-w-0 max-shell-mobile:flex-1",
              mobile && "h-11 min-w-0 max-w-none flex-1",
            )}
          >
            <SortAscending
              aria-hidden="true"
              className="policy-browser-sort-icon size-4 shrink-0 text-muted-foreground"
            />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {sortItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          aria-label={delayActive ? cancelAriaLabel : testAriaLabel}
          aria-busy={delayBusy || undefined}
          className={mobile ? "h-11 shrink-0 px-3" : undefined}
          disabled={delayBusy || (!delayActive && delayDisabled)}
          onClick={delayActive ? onCancel : onTest}
          size="sm"
          type="button"
          variant="outline"
        >
          {delayBusy ? (
            <Spinner data-icon="inline-start" />
          ) : delayActive ? (
            <XCircle aria-hidden="true" data-icon="inline-start" />
          ) : (
            <ArrowClockwise aria-hidden="true" data-icon="inline-start" />
          )}
          {delayActive ? cancelLabel : testLabel}
        </Button>
      </div>
      <div
        aria-live="polite"
        className={cx(
          mobile
            ? "mobile-policy-browser-progress min-h-4.5 min-w-0 text-caption text-muted-foreground"
            : "policy-browser-progress min-w-0 truncate text-caption text-muted-foreground max-shell-mobile:col-start-1 max-shell-mobile:row-auto max-shell-mobile:min-h-4.5 max-shell-mobile:whitespace-normal",
          !mobile &&
            (showSearch ? "col-span-2 max-shell-mobile:col-span-1" : "col-start-1 row-start-1"),
        )}
        role="status"
      >
        {delayProgress}
      </div>
    </div>
  );
}

interface BoundedEntityListProps {
  children(ids: readonly string[]): ReactNode;
  empty: ReactNode;
  ids: readonly string[];
  loadedAnnouncement(added: number, total: number): string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
  showMoreLabel(remaining: number): string;
}

export function BoundedEntityList({
  children,
  empty,
  ids,
  loadedAnnouncement,
  onKeyDown = handlePolicyPeerNavigation,
  showMoreLabel,
}: BoundedEntityListProps) {
  const [visibleLimit, setVisibleLimit] = useState(POLICY_ENTITY_BATCH_SIZE);
  const [announcement, setAnnouncement] = useState("");
  const visibleIds = ids.slice(0, visibleLimit);
  const remaining = Math.max(0, ids.length - visibleIds.length);
  if (ids.length === 0) return <>{empty}</>;
  return (
    <>
      <ul
        className="policy-browser-entity-list m-0 flex list-none flex-col gap-px bg-hairline-soft p-0 [&>li]:min-w-0 [&>li]:bg-canvas [&>li]:[contain-intrinsic-size:auto_52px] [&>li]:[content-visibility:auto]"
        onKeyDown={onKeyDown}
      >
        {children(visibleIds)}
      </ul>
      {remaining > 0 ? (
        <Button
          className="policy-browser-show-more h-11 w-full rounded-none border-x-0 border-b-0 border-t border-hairline-soft"
          onClick={() => {
            const added = Math.min(POLICY_ENTITY_BATCH_SIZE, remaining);
            setVisibleLimit((current) => current + POLICY_ENTITY_BATCH_SIZE);
            setAnnouncement(loadedAnnouncement(added, Math.min(ids.length, visibleLimit + added)));
          }}
          type="button"
          variant="outline"
        >
          {showMoreLabel(remaining)}
        </Button>
      ) : null}
      <span aria-live="polite" className="sr-only" role="status">
        {announcement}
      </span>
    </>
  );
}
