import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";
import { cn, tv } from "tailwind-variants";

export { cn } from "tailwind-variants";

// Recipes are intentionally the only shared component merge boundary. Consumer
// className values are passed to tv() last so documented page-level overrides win.
const buttonRecipe = tv({
  base: "ui-button inline-flex h-[34px] shrink-0 items-center justify-center gap-[7px] rounded-(--radius-md) border border-(--color-ink) bg-(--color-ink) px-[13px] text-(--text-metadata) font-(--font-weight-control) text-(--color-canvas) whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[15px] [&_svg]:shrink-0",
  variants: {
    variant: {
      default: "ui-button--default",
      outline:
        "ui-button--outline border-(--color-hairline) bg-(--color-canvas) text-(--color-ink) hover:bg-(--color-accent)",
      ghost:
        "ui-button--ghost border-transparent bg-transparent text-(--color-body) hover:bg-(--color-accent)",
      destructive:
        "ui-button--destructive border-transparent bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] text-(--color-error)",
    },
    size: {
      default: "ui-button--default",
      sm: "ui-button--sm",
      "icon-sm": "ui-button--icon-sm size-[30px] p-0",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

const badgeRecipe = tv({
  base: "ui-badge inline-flex h-[22px] min-w-6 items-center justify-center rounded-(--radius-full) border border-(--color-hairline) bg-(--color-surface-soft) px-[7px] text-[12px] font-(--font-weight-control) text-(--color-text-muted)",
  variants: {
    variant: {
      default: "",
      outline: "",
      success:
        "border-[color-mix(in_srgb,var(--color-success)_34%,var(--color-hairline))] bg-[color-mix(in_srgb,var(--color-success)_10%,var(--color-canvas))] text-(--color-success-text)",
      warning:
        "border-[color-mix(in_srgb,var(--color-warning)_32%,var(--color-hairline))] bg-[color-mix(in_srgb,var(--color-warning)_9%,var(--color-canvas))] text-(--color-warning)",
      destructive:
        "border-[color-mix(in_srgb,var(--color-error)_32%,var(--color-hairline))] bg-[color-mix(in_srgb,var(--color-error)_8%,var(--color-canvas))] text-(--color-error)",
    },
  },
  defaultVariants: { variant: "default" },
});

const sectionGridRecipe = tv({
  base: "section-grid grid grid-cols-[repeat(var(--section-grid-columns,1),minmax(0,1fr))] gap-px overflow-visible rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline-soft) p-0",
});

const sectionGridItemRecipe = tv({
  base: "section-grid-item col-span-(--section-grid-column-span) row-span-(--section-grid-row-span) min-w-0 overflow-clip bg-(--color-canvas)",
});

const settingsGroupRecipe = tv({
  base: "settings-group [&>:first-child]:rounded-t-[7px] [&>:last-child]:rounded-b-[7px]",
});

const settingsRowRecipe = tv({
  base: "settings-row grid min-h-[62px] grid-cols-[minmax(0,1fr)_max-content] items-center gap-5 px-[14px] py-[11px] @max-[680px]/settings-page:grid-cols-[minmax(0,1fr)] @max-[680px]/settings-page:items-start @max-[680px]/settings-page:gap-2.5",
});

const settingsRowCopyRecipe = tv({
  base: "settings-row-copy grid min-w-0 gap-0.5 [&_strong]:font-(--font-weight-control) [&_strong]:text-(--color-body) [&_span]:max-w-[590px] [&_span]:text-(--text-metadata) [&_span]:leading-[18px] [&_span]:text-(--color-text-muted)",
});

const settingsRowControlRecipe = tv({
  base: "settings-row-control grid min-w-fit justify-items-end text-end @max-[680px]/settings-page:w-full @max-[680px]/settings-page:min-w-0 @max-[680px]/settings-page:justify-items-start @max-[680px]/settings-page:text-start",
});

const toggleRecipe = tv({
  base: "ui-toggle inline-flex h-[34px] shrink-0 items-center justify-center gap-[7px] rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) px-[13px] text-(--text-metadata) font-(--font-weight-control) text-(--color-body) whitespace-nowrap outline-none hover:bg-(--color-accent) data-[pressed]:bg-(--color-accent) data-[pressed]:text-(--color-ink) disabled:pointer-events-none disabled:opacity-50",
  variants: {
    variant: {
      default: "",
      outline: "",
      capture:
        "h-[30px] gap-[7px] px-[10px] text-(--color-text-muted) [&_svg]:size-[15px] data-[capture-state=remembered]:text-(--color-text-muted) data-[capture-state=remembered]:[&_svg]:text-(--color-muted-soft) data-[capture-state=running]:text-(--color-body) data-[capture-state=running]:[&_svg]:text-[color-mix(in_srgb,var(--color-success)_64%,var(--color-muted-soft))]",
      "icon-capture": "size-[30px] p-0 [&_svg]:size-[15px] [&_svg]:text-(--color-muted-soft)",
    },
  },
  defaultVariants: { variant: "default" },
});

const toggleGroupRecipe = tv({
  base: "ui-toggle-group inline-flex w-fit items-center",
});

const toggleGroupItemRecipe = tv({
  base: "ui-toggle-group-item",
  variants: {
    variant: {
      default: "",
      outline: "",
      segmented:
        "inline-flex h-[30px] items-center justify-center border border-(--color-hairline) bg-(--color-canvas) px-[11px] text-(--text-metadata) text-(--color-text-muted) first:rounded-l-(--radius-md) last:rounded-r-(--radius-md) [&:not(:first-child)]:border-l-0 hover:bg-(--color-accent) hover:text-(--color-body) data-[pressed]:bg-(--color-accent) data-[pressed]:text-(--color-ink) data-[pressed]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-hairline)_56%,transparent)] disabled:cursor-not-allowed disabled:opacity-50",
    },
  },
  defaultVariants: { variant: "default" },
});

const inputRecipe = tv({
  base: "ui-input h-[38px] w-full rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) px-[10px] text-(--color-ink) outline-none aria-invalid:border-[color-mix(in_srgb,var(--color-error)_52%,var(--color-hairline))]",
});

const spinnerRecipe = tv({
  base: "ui-spinner size-[14px] shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:[animation-duration:1.5s]",
});

const tabsRecipe = tv({
  slots: {
    root: "ui-tabs flex min-h-0 flex-col",
    list: "ui-tabs-list inline-flex w-fit items-center gap-0.5 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-soft) p-[3px]",
    trigger:
      "ui-tabs-trigger inline-flex h-[30px] items-center gap-[7px] rounded-(--radius-sm) border-0 bg-transparent px-[10px] text-(--text-metadata) font-(--font-weight-control) text-(--color-text-muted) hover:bg-(--color-accent) hover:text-(--color-body) data-[active]:bg-(--color-accent) data-[active]:text-(--color-ink) data-[active]:shadow-[0_1px_2px_color-mix(in_srgb,var(--color-ink)_6%,transparent)] [&_.ui-badge]:min-w-5 [&_.ui-badge]:justify-center [&_.ui-badge]:px-[5px]",
    content: "ui-tabs-content min-h-0 outline-none",
  },
});

const selectRecipe = tv({
  slots: {
    trigger:
      "ui-select-trigger inline-flex h-[38px] min-w-[132px] items-center justify-between gap-2 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) px-[10px] text-(--text-metadata) text-(--color-body) disabled:opacity-50",
    icon: "ui-select-icon size-[14px] text-(--color-text-muted) [&_svg]:size-[14px]",
    positioner: "ui-select-positioner outline-none",
    content:
      "ui-select-content max-h-[min(320px,var(--available-height))] min-w-(--anchor-width) overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) text-(--color-body) shadow-(--shadow-float)",
    list: "ui-select-list overflow-auto p-1",
    item: "ui-select-item grid min-h-8 grid-cols-[minmax(0,1fr)_16px] items-center gap-2 rounded-(--radius-sm) px-2 text-(--text-metadata) outline-none data-[highlighted]:bg-(--color-accent) data-[highlighted]:text-(--color-ink)",
    indicator: "ui-select-item-indicator size-[14px] [&_svg]:size-[14px]",
  },
});

const tableRecipe = tv({
  slots: {
    container:
      "ui-table-container w-full overflow-auto rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas)",
    table: "ui-table w-full border-collapse text-(--text-metadata)",
    head: "ui-table-head h-9 border-b border-(--color-hairline) bg-(--color-surface-soft) px-[10px] text-left text-[12px] font-(--font-weight-control) text-(--color-text-muted) whitespace-nowrap",
    cell: "ui-table-cell h-12 max-w-[240px] overflow-hidden border-b border-(--color-hairline-soft) px-[10px] py-[6px] text-(--color-body) text-ellipsis whitespace-nowrap",
    row: "ui-table-row hover:[&_td]:bg-(--color-accent) last:[&_td]:border-b-0",
  },
});

const emptyRecipe = tv({
  slots: {
    root: "ui-empty flex min-h-[156px] flex-col items-center justify-center gap-[14px] rounded-(--radius-lg) border border-dashed border-(--color-hairline) text-center",
    header: "ui-empty-header grid gap-[5px]",
    title: "ui-empty-title font-(--font-weight-control)",
    description: "ui-empty-description text-(--text-metadata) text-(--color-text-muted)",
  },
});

const dialogRecipe = tv({
  slots: {
    backdrop:
      "dialog-backdrop fixed inset-0 z-[70] bg-[rgb(17_24_39_/_18%)] backdrop-blur-[2px] [html[data-theme=dark]_&]:bg-[rgb(0_0_0_/_45%)]",
    content:
      "dialog-content fixed top-1/2 left-1/2 z-[71] max-h-[min(620px,calc(100vh_-_48px))] w-[min(440px,calc(100vw_-_32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-(--radius-lg) border border-(--color-hairline) bg-(--color-canvas) shadow-(--shadow-float) outline-none",
    close:
      "dialog-close absolute top-[10px] right-[10px] grid size-[30px] place-items-center rounded-(--radius-md) border-0 bg-transparent text-(--color-text-muted) hover:bg-(--color-accent) hover:text-(--color-ink) [&_svg]:size-4",
    header:
      "dialog-header flex min-h-[74px] items-center border-b border-(--color-hairline) py-[13px] pr-11 pl-4",
    title: "dialog-title text-(--text-body) font-(--font-weight-heading)",
    description:
      "dialog-description mt-[3px] text-(--text-metadata) leading-[18px] text-(--color-text-muted)",
    footer:
      "dialog-footer flex min-h-[62px] items-center justify-end gap-2 border-t border-(--color-hairline) px-4 py-[10px]",
    alertContent: "alert-dialog-content w-[min(380px,calc(100vw_-_32px))] p-4 pb-0",
    alertHeader: "alert-dialog-header grid gap-[6px] pb-4",
    alertTitle: "text-(--text-body) font-(--font-weight-heading)",
    alertDescription: "text-(--text-metadata) leading-[19px] text-(--color-text-muted)",
    alertFooter: "alert-dialog-footer -mx-4",
  },
});

const menuRecipe = tv({
  slots: {
    positioner: "menu-positioner z-[60] outline-none",
    content:
      "menu-content max-h-(--available-height) min-w-[184px] overflow-auto rounded-[10px] border border-(--color-hairline) bg-(--color-canvas) p-[6px] text-(--color-ink) shadow-(--shadow-float) outline-none [transform-origin:var(--transform-origin)]",
    item: "menu-item relative flex min-h-[34px] items-center gap-2 rounded-(--radius-sm) px-[9px] text-(--text-metadata) text-(--color-body) outline-none select-none hover:bg-(--color-accent) hover:text-(--color-ink) data-[highlighted]:bg-(--color-accent) data-[highlighted]:text-(--color-ink) [&_svg]:size-[15px]",
    radioItem: "menu-radio-item pr-[30px]",
    indicator: "menu-radio-indicator absolute right-2 grid place-items-center [&_svg]:size-[14px]",
    separator: "menu-separator my-[5px] mx-[3px] h-px bg-(--color-hairline)",
  },
});

const popoverRecipe = tv({
  slots: {
    positioner: "popover-positioner outline-none",
    content:
      "popover-content max-h-(--available-height) overflow-hidden rounded-(--radius-lg) border border-(--color-hairline) bg-(--color-canvas) text-(--color-ink) shadow-(--shadow-float) outline-none [transform-origin:var(--transform-origin)] transition-[opacity,transform] duration-[120ms] ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
  },
});

const fieldRecipe = tv({
  slots: {
    group: "field-group flex flex-col gap-4",
    field: "field flex flex-col gap-[7px] data-[invalid=true]:text-(--color-error)",
    label: "field-label text-(--text-metadata) font-(--font-weight-control) text-(--color-body)",
    description: "field-description text-[12px] leading-[17px] text-(--color-text-muted)",
    error: "field-error text-[12px] leading-[17px] text-(--color-error)",
  },
});

const commandRecipe = tv({
  slots: {
    root: "command flex flex-col overflow-hidden bg-(--color-canvas)",
    inputWrapper:
      "command-input-wrapper flex h-[42px] items-center gap-2 border-b border-(--color-hairline) px-3 text-(--color-text-muted) [&_svg]:size-[15px]",
    input:
      "command-input w-full border-0 bg-transparent text-(--text-metadata) text-(--color-ink) outline-none",
    list: "command-list max-h-[380px] overflow-auto",
    empty: "command-empty px-4 py-7 text-center text-(--color-text-muted)",
    group: "command-group",
    item: "command-item relative flex min-h-[34px] items-center gap-2 rounded-(--radius-sm) px-[9px] text-(--text-metadata) text-(--color-body) outline-none data-[selected=true]:bg-(--color-accent) data-[selected=true]:text-(--color-ink) data-[selected=true]:[&_.command-item-check]:opacity-100",
    check: "command-item-check ml-auto size-[14px] opacity-0 data-[selected=true]:opacity-100",
  },
});

const tooltipRecipe = tv({
  base: "tooltip-content z-[80] max-w-[280px] rounded-(--radius-sm) bg-(--color-ink) px-2 py-[6px] text-[12px] leading-[17px] text-(--color-canvas) shadow-(--shadow-float)",
});

function resolveClassName<State>(
  className: string | ((state: State) => string | undefined) | undefined,
  recipe: (override: string | undefined) => string,
) {
  return typeof className === "function"
    ? (state: State) => recipe(className(state))
    : recipe(className);
}

export interface ButtonProps extends ComponentProps<typeof ButtonPrimitive> {
  disableWhileLoading?: boolean;
  loading?: boolean | PromiseLike<unknown>;
  loadingText?: ReactNode;
  size?: "default" | "sm" | "icon-sm";
  variant?: "default" | "outline" | "ghost" | "destructive";
}

export function Button({
  "aria-busy": ariaBusy,
  children,
  className,
  disabled,
  disableWhileLoading = true,
  loading = false,
  loadingText,
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  const loadingPending = usePromisePending(loading);

  return (
    <ButtonPrimitive
      aria-busy={loadingPending ? true : ariaBusy}
      className={resolveClassName(className, (override) =>
        buttonRecipe({ variant, size, className: override }),
      )}
      data-loading={loadingPending || undefined}
      data-slot="button"
      disabled={disabled || (disableWhileLoading && loadingPending)}
      {...props}
    >
      {loadingPending ? <Spinner data-icon="inline-start" /> : null}
      {loadingPending && loadingText !== undefined ? loadingText : children}
    </ButtonPrimitive>
  );
}

function usePromisePending(loading: ButtonProps["loading"]) {
  const promise = isPromiseLike(loading) ? loading : null;
  const [settledPromise, setSettledPromise] = useState<PromiseLike<unknown> | null>(null);

  useEffect(() => {
    if (!promise) return;
    let active = true;
    const settle = () => {
      if (active) setSettledPromise(promise);
    };
    void Promise.resolve(promise).then(settle, settle);
    return () => {
      active = false;
    };
  }, [promise]);

  return typeof loading === "boolean" ? loading : promise !== null && promise !== settledPromise;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "outline" | "success" | "warning" | "destructive";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return <span className={badgeRecipe({ variant, className })} data-slot="badge" {...props} />;
}

export interface SectionGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: number;
}

export function SectionGrid({ className, columns = 1, style, ...props }: SectionGridProps) {
  return (
    <div
      className={sectionGridRecipe({ className })}
      style={{ ...style, "--section-grid-columns": columns } as CSSProperties}
      {...props}
    />
  );
}

export interface SectionGridItemProps extends HTMLAttributes<HTMLDivElement> {
  columnSpan?: number;
  rowSpan?: number;
}

export function SectionGridItem({
  className,
  columnSpan = 1,
  rowSpan = 1,
  style,
  ...props
}: SectionGridItemProps) {
  return (
    <div
      className={sectionGridItemRecipe({ className })}
      style={
        {
          ...style,
          "--section-grid-column-span": columnSpan,
          "--section-grid-row-span": rowSpan,
        } as CSSProperties
      }
      {...props}
    />
  );
}

export function SettingsGroup({ className, ...props }: SectionGridProps) {
  return (
    <SectionGrid
      className={settingsGroupRecipe({ className })}
      data-slot="settings-group"
      {...props}
    />
  );
}

export function SettingsRow({ className, ...props }: SectionGridItemProps) {
  return (
    <SectionGridItem
      className={settingsRowRecipe({ className })}
      data-slot="settings-row"
      {...props}
    />
  );
}

export function SettingsRowCopy({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={settingsRowCopyRecipe({ className })}
      data-slot="settings-row-copy"
      {...props}
    />
  );
}

export function SettingsRowControl({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={settingsRowControlRecipe({ className })}
      data-slot="settings-row-control"
      {...props}
    />
  );
}

export interface ToggleProps extends ComponentProps<typeof TogglePrimitive> {
  variant?: "default" | "outline" | "capture" | "icon-capture";
}

export function Toggle({ className, variant = "default", ...props }: ToggleProps) {
  return (
    <TogglePrimitive
      className={resolveClassName(className, (override) =>
        toggleRecipe({ variant, className: override }),
      )}
      data-slot="toggle"
      {...props}
    />
  );
}

interface ToggleGroupContextValue {
  spacing: number;
  variant: "default" | "outline" | "segmented";
}

const ToggleGroupContext = createContext<ToggleGroupContextValue>({
  spacing: 2,
  variant: "default",
});

export interface ToggleGroupProps extends ComponentProps<typeof ToggleGroupPrimitive> {
  spacing?: number;
  variant?: "default" | "outline" | "segmented";
}

export function ToggleGroup({
  children,
  className,
  spacing = 2,
  variant = "default",
  ...props
}: ToggleGroupProps) {
  return (
    <ToggleGroupPrimitive
      className={resolveClassName(className, (override) =>
        toggleGroupRecipe({ className: override }),
      )}
      data-spacing={spacing}
      data-variant={variant}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ spacing, variant }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

export type ToggleGroupItemProps = ComponentProps<typeof TogglePrimitive>;

export function ToggleGroupItem({ className, ...props }: ToggleGroupItemProps) {
  const context = useContext(ToggleGroupContext);

  return (
    <TogglePrimitive
      className={resolveClassName(className, (override) =>
        toggleGroupItemRecipe({ variant: context.variant, className: override }),
      )}
      data-spacing={context.spacing}
      data-variant={context.variant}
      {...props}
    />
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      {...props}
      className={resolveClassName(className, (override) =>
        dialogRecipe().title({ className: override }),
      )}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      {...props}
      className={resolveClassName(className, (override) =>
        dialogRecipe().description({ className: override }),
      )}
    />
  );
}

export function DialogHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={dialogRecipe().header({ className: props.className })} />;
}

export function DialogFooter(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={dialogRecipe().footer({ className: props.className })} />;
}

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Popup> {
  closeLabel?: string;
  showCloseButton?: boolean;
}

export function DialogContent({
  children,
  className,
  closeLabel = "Close",
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className={dialogRecipe().backdrop()} />
      <DialogPrimitive.Popup
        className={resolveClassName(className, (override) =>
          dialogRecipe().content({ className: override }),
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close aria-label={closeLabel} className={dialogRecipe().close()}>
            <X aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuLabel = MenuPrimitive.GroupLabel;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export interface DropdownMenuContentProps extends ComponentProps<typeof MenuPrimitive.Popup> {
  align?: ComponentProps<typeof MenuPrimitive.Positioner>["align"];
  alignOffset?: number;
  side?: ComponentProps<typeof MenuPrimitive.Positioner>["side"];
  sideOffset?: number;
}

export function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  className,
  side = "bottom",
  sideOffset = 4,
  ...props
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className={menuRecipe().positioner()}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={resolveClassName(className, (override) =>
            menuRecipe().content({ className: override }),
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export type DropdownMenuItemProps = ComponentProps<typeof MenuPrimitive.Item>;

export function DropdownMenuItem({ className, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={resolveClassName(className, (override) =>
        menuRecipe().item({ className: override }),
      )}
      {...props}
    />
  );
}

export interface DropdownMenuRadioItemProps extends ComponentProps<typeof MenuPrimitive.RadioItem> {
  children: ReactNode;
}

export function DropdownMenuRadioItem({
  children,
  className,
  closeOnClick = true,
  ...props
}: DropdownMenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      className={menuRecipe().item({ className: cn(menuRecipe().radioItem(), className) })}
      closeOnClick={closeOnClick}
      {...props}
    >
      {children}
      <MenuPrimitive.RadioItemIndicator className={menuRecipe().indicator()}>
        <Check aria-hidden="true" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      className={resolveClassName(className, (override) =>
        menuRecipe().separator({ className: override }),
      )}
      {...props}
    />
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverTitle = PopoverPrimitive.Title;
export const PopoverDescription = PopoverPrimitive.Description;

export interface PopoverContentProps extends ComponentProps<typeof PopoverPrimitive.Popup> {
  align?: ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  alignOffset?: number;
  side?: ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  sideOffset?: number;
}

export function PopoverContent({
  align = "center",
  alignOffset = 0,
  className,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className={popoverRecipe().positioner()}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={resolveClassName(className, (override) =>
            popoverRecipe().content({ className: override }),
          )}
          data-slot="popover-content"
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export const AlertDialog = AlertDialogPrimitive.Root;

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      {...props}
      className={resolveClassName(className, (override) =>
        dialogRecipe().alertTitle({ className: override }),
      )}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      {...props}
      className={resolveClassName(className, (override) =>
        dialogRecipe().alertDescription({ className: override }),
      )}
    />
  );
}

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className={dialogRecipe().backdrop()} />
      <AlertDialogPrimitive.Popup
        className={resolveClassName(
          className,
          (override) =>
            cn(dialogRecipe().content(), dialogRecipe().alertContent({ className: override })) ??
            "",
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogAction(props: ButtonProps) {
  return <Button {...props} />;
}

export function AlertDialogCancel({ children }: { children: ReactNode }) {
  return (
    <AlertDialogPrimitive.Close render={<Button variant="outline" />}>
      {children}
    </AlertDialogPrimitive.Close>
  );
}

export function AlertDialogHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={dialogRecipe().alertHeader({ className: props.className })} />;
}

export function AlertDialogFooter(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={dialogRecipe().alertFooter({ className: props.className })} />;
}

export function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      className={resolveClassName(className, (override) => inputRecipe({ className: override }))}
      data-slot="input"
      {...props}
    />
  );
}

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      className={resolveClassName(className, (override) =>
        tabsRecipe().root({ className: override }),
      )}
      data-slot="tabs"
      {...props}
    />
  );
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={resolveClassName(className, (override) =>
        tabsRecipe().list({ className: override }),
      )}
      data-slot="tabs-list"
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={resolveClassName(className, (override) =>
        tabsRecipe().trigger({ className: override }),
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      className={resolveClassName(className, (override) =>
        tabsRecipe().content({ className: override }),
      )}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  children,
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={resolveClassName(className, (override) =>
        selectRecipe().trigger({ className: override }),
      )}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className={selectRecipe().icon()}>
        <ChevronDown aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

interface SelectContentProps extends ComponentProps<typeof SelectPrimitive.Popup> {
  align?: ComponentProps<typeof SelectPrimitive.Positioner>["align"];
  alignItemWithTrigger?: boolean;
  side?: ComponentProps<typeof SelectPrimitive.Positioner>["side"];
  sideOffset?: number;
}

export function SelectContent({
  align = "start",
  alignItemWithTrigger = false,
  children,
  className,
  side = "bottom",
  sideOffset = 4,
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        className={selectRecipe().positioner()}
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className={resolveClassName(className, (override) =>
            selectRecipe().content({ className: override }),
          )}
          data-slot="select-content"
          {...props}
        >
          <SelectPrimitive.List className={selectRecipe().list()}>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  children,
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={resolveClassName(className, (override) =>
        selectRecipe().item({ className: override }),
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className={selectRecipe().indicator()}>
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className={tableRecipe().container()} data-slot="table-container">
      <table className={tableRecipe().table({ className })} data-slot="table" {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("ui-table-header", className)} data-slot="table-header" {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("ui-table-body", className)} data-slot="table-body" {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={tableRecipe().row({ className })} data-slot="table-row" {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={tableRecipe().head({ className })} data-slot="table-head" {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={tableRecipe().cell({ className })} data-slot="table-cell" {...props} />;
}

export function FieldGroup(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={fieldRecipe().group({ className: props.className })}
      data-slot="field-group"
    />
  );
}

export function Field(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={fieldRecipe().field({ className: props.className })}
      data-slot="field"
      role="group"
    />
  );
}

export function FieldLabel(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      {...props}
      className={fieldRecipe().label({ className: props.className })}
      data-slot="field-label"
    />
  );
}

export function FieldDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...props}
      className={fieldRecipe().description({ className: props.className })}
      data-slot="field-description"
    />
  );
}

export function FieldError(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={fieldRecipe().error({ className: props.className })}
      data-slot="field-error"
      role="alert"
    />
  );
}

export function Empty(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={emptyRecipe().root({ className: props.className })}
      data-slot="empty"
    />
  );
}

export function EmptyHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={emptyRecipe().header({ className: props.className })} />;
}

export function EmptyTitle(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={emptyRecipe().title({ className: props.className })} />;
}

export function EmptyDescription(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={emptyRecipe().description({ className: props.className })} />;
}

export function Spinner(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span aria-hidden="true" {...props} className={spinnerRecipe({ className: props.className })} />
  );
}

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn(commandRecipe().root(), className)} {...props} />;
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className={commandRecipe().inputWrapper()}>
      <Search aria-hidden="true" />
      <CommandPrimitive.Input className={cn(commandRecipe().input(), className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn(commandRecipe().list(), className)} {...props} />;
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn(commandRecipe().empty(), className)} {...props} />;
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn(commandRecipe().group(), className)} {...props} />;
}

export function CommandItem({
  children,
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item className={cn(commandRecipe().item(), className)} {...props}>
      {children}
      <Check aria-hidden="true" className={commandRecipe().check()} />
    </CommandPrimitive.Item>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps extends ComponentProps<typeof TooltipPrimitive.Popup> {
  sideOffset?: number;
}

export function TooltipContent({ className, sideOffset = 6, ...props }: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={sideOffset}>
        <TooltipPrimitive.Popup className={cn(tooltipRecipe(), className)} {...props} />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
