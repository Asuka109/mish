import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { Check } from "@phosphor-icons/react/Check";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { XCircle } from "@phosphor-icons/react/XCircle";
import type { GroupDelayChildResultDto, PolicyGroupDto, ProxyNodeDto } from "@mish/contracts";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { tv } from "tailwind-variants";
import { normalizeMeasuredLatency, POLICY_ENTITY_BATCH_SIZE } from "../pages/routes-model";

export type PolicyBrowserDensity = "default" | "compact";
export type PolicyEntityKind = "node" | "group";
export type PolicySelectionState = "current" | "pending" | "unselected" | "read-only";
export type PolicyLatencyState = "measured" | "unknown" | "testing" | "failed" | "cancelled";

const policyGroupSummaryRecipe = tv({
  base: "policy-browser-group-summary",
  variants: {
    density: {
      compact: "policy-browser-group-summary--compact",
      default: "policy-browser-group-summary--default",
    },
    interactive: {
      false: "policy-browser-group-summary--static",
      true: "policy-browser-group-summary--interactive",
    },
  },
  defaultVariants: { density: "default", interactive: true },
});

const policyEntityRowRecipe = tv({
  base: "policy-browser-entity-row",
  variants: {
    density: {
      compact: "policy-browser-entity-row--compact",
      default: "policy-browser-entity-row--default",
    },
    entityKind: {
      group: "policy-browser-entity-row--group",
      node: "policy-browser-entity-row--node",
    },
    interactive: {
      false: "policy-browser-entity-row--static",
      true: "policy-browser-entity-row--interactive",
    },
    selectionState: {
      current: "policy-browser-entity-row--current",
      pending: "policy-browser-entity-row--pending",
      "read-only": "policy-browser-entity-row--read-only",
      unselected: "policy-browser-entity-row--unselected",
    },
  },
  defaultVariants: {
    density: "default",
    entityKind: "node",
    interactive: true,
    selectionState: "unselected",
  },
});

const latencyStatusRecipe = tv({
  base: "policy-browser-latency tabular",
  variants: {
    latencyState: {
      cancelled: "policy-browser-latency--cancelled",
      failed: "policy-browser-latency--failed",
      measured: "policy-browser-latency--measured",
      testing: "policy-browser-latency--testing",
      unknown: "policy-browser-latency--unknown",
    },
  },
  defaultVariants: { latencyState: "unknown" },
});

const selectionStatusRecipe = tv({
  base: "policy-browser-selection",
  variants: {
    selectionState: {
      current: "policy-browser-selection--current",
      pending: "policy-browser-selection--pending",
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
  unknownLabel: string;
}

export function LatencyStatus({
  cancelledLabel,
  failureLabel,
  latencyMilliseconds,
  measuredLabel,
  result,
  testingLabel,
  unknownLabel,
}: LatencyStatusProps) {
  const historical = normalizeMeasuredLatency(latencyMilliseconds);
  const state = delayState(result) ?? (historical === null ? "unknown" : "measured");
  const latency =
    result?.phase === "success" ? normalizeMeasuredLatency(result.latencyMilliseconds) : historical;
  const label =
    state === "testing"
      ? testingLabel
      : state === "cancelled"
        ? cancelledLabel
        : state === "failed" && result
          ? failureLabel(result)
          : latency === null
            ? unknownLabel
            : measuredLabel(latency);
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
  pending = false,
  rank,
  typeLabel,
}: PolicyGroupSummaryRowProps) {
  const content = (
    <>
      {rank === undefined ? null : <span className="policy-browser-rank tabular">{rank}</span>}
      <span className="policy-browser-summary-copy">
        <span className="policy-browser-summary-title-line">
          <strong className="user-authored-label" title={group.label}>
            {group.label}
          </strong>
          {typeLabel ? <Badge variant="outline">{typeLabel}</Badge> : null}
        </span>
        <span className="policy-browser-summary-current user-authored-label">
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
      <div className={policyGroupSummaryRecipe({ density, interactive: false })}>{content}</div>
    );
  }
  return (
    <Button
      aria-busy={pending || undefined}
      className={policyGroupSummaryRecipe({ density, interactive: true })}
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
  browseLabel?: string;
  browseTo?: string;
  currentLabel: string;
  density?: PolicyBrowserDensity;
  disabled?: boolean;
  entity: PolicyGroupDto | ProxyNodeDto;
  entityKind: PolicyEntityKind;
  latency: ReactNode;
  metadata: string;
  onBrowse?: () => void;
  onSelect?: () => void;
  pendingLabel: string;
  readOnlyLabel: string;
  selectLabel?: string;
  selected: boolean;
  selectionPending: boolean;
}

export function PolicyEntityRow({
  browseLabel,
  browseTo,
  currentLabel,
  density = "default",
  disabled = false,
  entity,
  entityKind,
  latency,
  metadata,
  onBrowse,
  onSelect,
  pendingLabel,
  readOnlyLabel,
  selectLabel,
  selected,
  selectionPending,
}: PolicyEntityRowProps) {
  const selectionState: PolicySelectionState = selectionPending
    ? "pending"
    : selected
      ? "current"
      : onSelect
        ? "unselected"
        : "read-only";
  const content = (
    <>
      <span className="policy-browser-entity-copy">
        <strong className="user-authored-label" title={entity.label}>
          {entity.label}
        </strong>
        <span>{metadata}</span>
      </span>
      <span className="policy-browser-entity-status">
        {latency}
        <SelectionStatus
          currentLabel={currentLabel}
          pendingLabel={pendingLabel}
          readOnlyLabel={readOnlyLabel}
          state={selectionState}
        />
      </span>
    </>
  );
  return (
    <div
      className={policyEntityRowRecipe({
        density,
        entityKind,
        interactive: Boolean(onSelect),
        selectionState,
      })}
      data-entity-id={entity.id}
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
        <Link aria-label={browseLabel} className="policy-browser-browse" to={browseTo}>
          <CaretRight aria-hidden="true" />
        </Link>
      ) : onBrowse ? (
        <Button
          aria-label={browseLabel}
          className="policy-browser-browse"
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
  return (
    <div className="policy-browser-toolbar">
      {showSearch ? (
        <Field className="policy-browser-search-field">
          <FieldLabel className="sr-only" htmlFor={searchId}>
            {searchLabel}
          </FieldLabel>
          <span className="policy-browser-search-control">
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
            />
          </span>
        </Field>
      ) : null}
      <div className="policy-browser-toolbar-actions">
        <ToggleGroup
          aria-label={sortLabel}
          className="policy-browser-sort"
          onValueChange={(values) => {
            const next = values[0] as Sort | undefined;
            if (next) onSortChange(next);
          }}
          spacing={0}
          value={[sort]}
          variant="outline"
        >
          {sorts.map((option) => (
            <ToggleGroupItem
              className="policy-browser-sort-option"
              disabled={sortDisabled}
              key={option}
              value={option}
            >
              {sortOptionLabel(option)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          aria-label={delayActive ? cancelAriaLabel : testAriaLabel}
          aria-busy={delayBusy || undefined}
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
      <div aria-live="polite" className="policy-browser-progress" role="status">
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
      <ul className="policy-browser-entity-list" onKeyDown={onKeyDown}>
        {children(visibleIds)}
      </ul>
      {remaining > 0 ? (
        <Button
          className="policy-browser-show-more"
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
