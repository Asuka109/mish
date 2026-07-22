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
import { cn, cx, tv } from "tailwind-variants";

export { cn } from "tailwind-variants";

// Recipes are intentionally the only shared component merge boundary. Consumer
// className values are passed to tv() last so documented page-level overrides win.
const buttonRecipe = tv({
  base: cx(
    "ui-button inline-flex h-8.5 shrink-0 items-center justify-center gap-1.75 rounded-md border",
    "border-ink bg-ink px-3.25 text-metadata font-medium text-canvas whitespace-nowrap",
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.75 [&_svg]:shrink-0",
  ),
  variants: {
    variant: {
      default: "ui-button--default",
      outline: "ui-button--outline border-hairline bg-canvas text-ink hover:bg-accent",
      ghost: "ui-button--ghost border-transparent bg-transparent text-fg hover:bg-accent",
      destructive:
        "ui-button--destructive border-transparent bg-button-destructive-subtle text-error",
    },
    size: {
      default: "ui-button--default",
      sm: "ui-button--sm",
      "icon-sm": "ui-button--icon-sm size-7.5 p-0",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

const badgeRecipe = tv({
  base: cx(
    "ui-badge inline-flex h-5.5 min-w-6 items-center justify-center rounded-full border",
    "border-hairline bg-surface-soft px-1.75 text-caption font-medium text-muted-foreground",
  ),
  variants: {
    variant: {
      default: "",
      outline: "",
      success: "border-badge-success-border bg-badge-success-background text-success-text",
      warning: "border-badge-warning-border bg-badge-warning-background text-warning",
      destructive: "border-badge-error-border bg-badge-error-background text-error",
    },
  },
  defaultVariants: { variant: "default" },
});

const sectionGridRecipe = tv({
  base: cx(
    "section-grid grid grid-cols-[repeat(var(--section-grid-columns,1),minmax(0,1fr))] gap-px",
    "overflow-visible rounded-md border border-hairline bg-hairline-soft p-0",
  ),
});

const sectionGridItemRecipe = tv({
  base: cx(
    "section-grid-item col-span-(--section-grid-column-span) row-span-(--section-grid-row-span)",
    "min-w-0 overflow-clip bg-canvas",
  ),
});

const settingsGroupRecipe = tv({
  base: cx(
    "settings-group [&>:first-child]:rounded-t-section-grid-inner",
    "[&>:last-child]:rounded-b-section-grid-inner",
  ),
});

const settingsRowRecipe = tv({
  base: cx(
    "settings-row grid min-h-15.5 grid-cols-[minmax(0,1fr)_max-content] items-center gap-5 px-3.5",
    "py-2.75 @max-settings-compact/settings-page:grid-cols-[minmax(0,1fr)]",
    "@max-settings-compact/settings-page:items-start @max-settings-compact/settings-page:gap-2.5",
  ),
});

const settingsRowCopyRecipe = tv({
  base: cx(
    "settings-row-copy grid min-w-0 gap-0.5 [&_strong]:font-medium [&_strong]:text-fg",
    "[&_span]:max-w-settings-description [&_span]:text-metadata [&_span]:leading-4.5",
    "[&_span]:text-muted-foreground",
  ),
});

const settingsRowControlRecipe = tv({
  base: cx(
    "settings-row-control grid min-w-fit justify-items-end text-end",
    "@max-settings-compact/settings-page:w-full @max-settings-compact/settings-page:min-w-0",
    "@max-settings-compact/settings-page:justify-items-start",
    "@max-settings-compact/settings-page:text-start",
  ),
});

const toggleRecipe = tv({
  base: cx(
    "ui-toggle inline-flex h-8.5 shrink-0 items-center justify-center gap-1.75 rounded-md border",
    "border-hairline bg-canvas px-3.25 text-metadata font-medium text-fg whitespace-nowrap",
    "outline-none hover:bg-accent data-pressed:bg-accent data-pressed:text-ink",
    "disabled:pointer-events-none disabled:opacity-50",
  ),
  variants: {
    variant: {
      default: "",
      outline: "",
      capture: cx(
        "h-7.5 gap-1.75 px-2.5 text-muted-foreground [&_svg]:size-3.75",
        "data-[capture-state=remembered]:text-muted-foreground",
        "data-[capture-state=remembered]:[&_svg]:text-muted-soft data-[capture-state=running]:text-fg",
        "data-[capture-state=running]:[&_svg]:text-toggle-capture-running-icon",
      ),
      "icon-capture": "size-7.5 p-0 [&_svg]:size-3.75 [&_svg]:text-muted-soft",
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
      segmented: cx(
        "inline-flex h-7.5 items-center justify-center border border-hairline bg-canvas px-2.75",
        "text-metadata text-muted-foreground first:rounded-l-md last:rounded-r-md",
        "[&:not(:first-child)]:border-l-0 hover:bg-accent hover:text-fg data-pressed:bg-accent",
        "data-pressed:text-ink data-pressed:shadow-toggle-group-selected disabled:cursor-not-allowed",
        "disabled:opacity-50",
      ),
    },
  },
  defaultVariants: { variant: "default" },
});

const inputRecipe = tv({
  base: cx(
    "ui-input h-9.5 w-full rounded-md border border-hairline bg-canvas px-2.5 text-ink",
    "outline-none aria-invalid:border-input-invalid-border",
  ),
});

const spinnerRecipe = tv({
  base: cx(
    "ui-spinner spinner-border size-3.5 shrink-0 animate-spin rounded-full border-current",
    "border-r-transparent motion-reduce:animate-spinner-reduced",
  ),
});

const tabsRecipe = tv({
  slots: {
    root: "ui-tabs flex min-h-0 flex-col",
    list: cx(
      "ui-tabs-list inline-flex w-fit items-center gap-0.5 rounded-md border",
      "border-hairline bg-surface-soft p-0.75",
    ),
    trigger: cx(
      "ui-tabs-trigger inline-flex h-7.5 items-center gap-1.75 rounded-sm border-0 bg-transparent",
      "px-2.5 text-metadata font-medium text-muted-foreground hover:bg-accent hover:text-fg",
      "data-active:bg-accent data-active:text-ink data-active:shadow-tabs-active",
      "[&_.ui-badge]:min-w-5 [&_.ui-badge]:justify-center [&_.ui-badge]:px-1.25",
    ),
    content: "ui-tabs-content min-h-0 outline-none",
  },
});

const selectRecipe = tv({
  slots: {
    trigger: cx(
      "ui-select-trigger inline-flex h-9.5 min-w-33 items-center justify-between gap-2 rounded-md",
      "border border-hairline bg-canvas px-2.5 text-metadata text-fg disabled:opacity-50",
    ),
    icon: "ui-select-icon size-3.5 text-muted-foreground [&_svg]:size-3.5",
    positioner: "ui-select-positioner outline-none",
    content: cx(
      "ui-select-content max-h-[min(var(--container-select-list),var(--available-height))]",
      "min-w-(--anchor-width) overflow-hidden rounded-md border border-hairline bg-canvas text-fg",
      "shadow-float",
    ),
    list: "ui-select-list overflow-auto p-1",
    item: cx(
      "ui-select-item grid min-h-8 grid-cols-[minmax(0,1fr)_16px] items-center gap-2 rounded-sm",
      "px-2 text-metadata outline-none data-highlighted:bg-accent data-highlighted:text-ink",
    ),
    indicator: "ui-select-item-indicator size-3.5 [&_svg]:size-3.5",
  },
});

const tableRecipe = tv({
  slots: {
    container:
      "ui-table-container w-full overflow-auto rounded-md border border-hairline bg-canvas",
    table: "ui-table w-full border-collapse text-metadata",
    head: cx(
      "ui-table-head h-9 border-b border-hairline bg-surface-soft px-2.5 text-left text-caption",
      "font-medium text-muted-foreground whitespace-nowrap",
    ),
    cell: cx(
      "ui-table-cell h-12 max-w-60 overflow-hidden border-b border-hairline-soft px-2.5 py-1.5",
      "text-fg text-ellipsis whitespace-nowrap",
    ),
    row: "ui-table-row hover:[&_td]:bg-accent last:[&_td]:border-b-0",
  },
});

const emptyRecipe = tv({
  slots: {
    root: cx(
      "ui-empty flex min-h-39 flex-col items-center justify-center gap-3.5 rounded-lg border",
      "border-dashed border-hairline text-center",
    ),
    header: "ui-empty-header grid gap-1.25",
    title: "ui-empty-title font-medium",
    description: "ui-empty-description text-metadata text-muted-foreground",
  },
});

const dialogRecipe = tv({
  slots: {
    backdrop: "dialog-backdrop fixed inset-0 z-70 bg-dialog-backdrop backdrop-blur-dialog-backdrop",
    content: cx(
      "dialog-content fixed top-1/2 left-1/2 z-71",
      "max-h-[min(var(--container-dialog-height),calc(100vh_-_48px))]",
      "w-[min(var(--container-dialog),calc(100vw_-_32px))] -translate-x-1/2 -translate-y-1/2",
      "overflow-auto rounded-lg border border-hairline bg-canvas shadow-float outline-none",
    ),
    close: cx(
      "dialog-close absolute top-2.5 right-2.5 grid size-7.5 place-items-center rounded-md border-0",
      "bg-transparent text-muted-foreground hover:bg-accent hover:text-ink [&_svg]:size-4",
    ),
    header:
      "dialog-header flex min-h-18.5 items-center border-b border-hairline py-3.25 pr-11 pl-4",
    title: "dialog-title text-body font-semibold",
    description: "dialog-description mt-0.75 text-metadata leading-4.5 text-muted-foreground",
    footer:
      "dialog-footer flex min-h-15.5 items-center justify-end gap-2 border-t border-hairline px-4 py-2.5",
    alertContent:
      "alert-dialog-content w-[min(var(--container-alert-dialog),calc(100vw_-_32px))] p-4 pb-0",
    alertHeader: "alert-dialog-header grid gap-1.5 pb-4",
    alertTitle: "text-body font-semibold",
    alertDescription: "text-metadata leading-4.75 text-muted-foreground",
    alertFooter: "alert-dialog-footer -mx-4",
  },
});

const menuRecipe = tv({
  slots: {
    positioner: "menu-positioner z-60 outline-none",
    content: cx(
      "menu-content max-h-(--available-height) min-w-46 overflow-auto rounded-compact border",
      "border-hairline bg-canvas p-1.5 text-ink shadow-float outline-none",
      "origin-(--transform-origin)",
    ),
    item: cx(
      "menu-item relative flex min-h-8.5 items-center gap-2 rounded-sm px-2.25 text-metadata",
      "text-fg outline-none select-none hover:bg-accent hover:text-ink data-highlighted:bg-accent",
      "data-highlighted:text-ink [&_svg]:size-3.75",
    ),
    radioItem: "menu-radio-item pr-7.5",
    indicator: "menu-radio-indicator absolute right-2 grid place-items-center [&_svg]:size-3.5",
    separator: "menu-separator my-1.25 mx-0.75 h-px bg-hairline",
  },
});

const popoverRecipe = tv({
  slots: {
    positioner: "popover-positioner outline-none",
    content: cx(
      "popover-content max-h-(--available-height) overflow-hidden rounded-lg border border-hairline",
      "bg-canvas text-ink shadow-float outline-none origin-(--transform-origin)",
      "transition-[opacity,transform] duration-120 ease-out data-starting-style:scale-overlay-enter",
      "data-starting-style:opacity-0 data-ending-style:scale-overlay-enter",
      "data-ending-style:opacity-0",
    ),
  },
});

const fieldRecipe = tv({
  slots: {
    group: "field-group flex flex-col gap-4",
    field: "field flex flex-col gap-1.75 data-[invalid=true]:text-error",
    label: "field-label text-metadata font-medium text-fg",
    description: "field-description text-caption leading-4.25 text-muted-foreground",
    error: "field-error text-caption leading-4.25 text-error",
  },
});

const commandRecipe = tv({
  slots: {
    root: "command flex flex-col overflow-hidden bg-canvas",
    inputWrapper: cx(
      "command-input-wrapper flex h-10.5 items-center gap-2 border-b border-hairline px-3",
      "text-muted-foreground [&_svg]:size-3.75",
    ),
    input: "command-input w-full border-0 bg-transparent text-metadata text-ink outline-none",
    list: "command-list max-h-95 overflow-auto",
    empty: "command-empty px-4 py-7 text-center text-muted-foreground",
    group: "command-group",
    item: cx(
      "command-item relative flex min-h-8.5 items-center gap-2 rounded-sm px-2.25 text-metadata",
      "text-fg outline-none data-[selected=true]:bg-accent data-[selected=true]:text-ink",
      "data-[selected=true]:[&_.command-item-check]:opacity-100",
    ),
    check: "command-item-check ml-auto size-3.5 opacity-0 data-[selected=true]:opacity-100",
  },
});

const tooltipRecipe = tv({
  base: cx(
    "tooltip-content z-80 max-w-tooltip rounded-sm bg-ink px-2 py-1.5 text-caption leading-4.25",
    "text-canvas shadow-float",
  ),
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
