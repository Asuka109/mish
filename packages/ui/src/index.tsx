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
  base: "ui-badge inline-flex min-h-5 items-center gap-1 rounded-(--radius-full) border border-(--color-hairline) bg-(--color-canvas) px-2 text-[12px] font-(--font-weight-control) text-(--color-body)",
  variants: {
    variant: {
      default: "",
      outline: "",
      success:
        "border-transparent bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-(--color-success-text)",
      warning:
        "border-transparent bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-(--color-warning)",
      destructive:
        "border-transparent bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] text-(--color-error)",
    },
  },
  defaultVariants: { variant: "default" },
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
      className={cn("section-grid", className)}
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
      className={cn("section-grid-item", className)}
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
      className={cn("ui-toggle-group inline-flex w-fit items-center", className)}
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
      className={cn(
        "ui-toggle-group-item",
        context.variant === "segmented" &&
          "inline-flex h-[30px] items-center justify-center border border-(--color-hairline) bg-(--color-canvas) px-[11px] text-(--text-metadata) text-(--color-text-muted) first:rounded-l-(--radius-md) last:rounded-r-(--radius-md) [&:not(:first-child)]:border-l-0 hover:bg-(--color-accent) hover:text-(--color-body) data-[pressed]:bg-(--color-accent) data-[pressed]:text-(--color-ink) data-[pressed]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-hairline)_56%,transparent)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
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
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("dialog-header", props.className)} />;
}

export function DialogFooter(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("dialog-footer", props.className)} />;
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
      <DialogPrimitive.Backdrop className="dialog-backdrop" />
      <DialogPrimitive.Popup className={cn("dialog-content", className)} {...props}>
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close aria-label={closeLabel} className="dialog-close">
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
        className="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup className={cn("menu-content", className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export type DropdownMenuItemProps = ComponentProps<typeof MenuPrimitive.Item>;

export function DropdownMenuItem({ className, ...props }: DropdownMenuItemProps) {
  return <MenuPrimitive.Item className={cn("menu-item", className)} {...props} />;
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
      className={cn("menu-item menu-radio-item", className)}
      closeOnClick={closeOnClick}
      {...props}
    >
      {children}
      <MenuPrimitive.RadioItemIndicator className="menu-radio-indicator">
        <Check aria-hidden="true" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("menu-separator", className)} {...props} />;
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
        className="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn("popover-content", className)}
          data-slot="popover-content"
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="dialog-backdrop" />
      <AlertDialogPrimitive.Popup
        className={cn("dialog-content alert-dialog-content", className)}
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
  return <div {...props} className={cn("alert-dialog-header", props.className)} />;
}

export function AlertDialogFooter(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("alert-dialog-footer", props.className)} />;
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
  return <div {...props} className={cn("field-group", props.className)} data-slot="field-group" />;
}

export function Field(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("field", props.className)} data-slot="field" role="group" />;
}

export function FieldLabel(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label {...props} className={cn("field-label", props.className)} data-slot="field-label" />
  );
}

export function FieldDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...props}
      className={cn("field-description", props.className)}
      data-slot="field-description"
    />
  );
}

export function FieldError(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn("field-error", props.className)}
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
  return <CommandPrimitive className={cn("command", className)} {...props} />;
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="command-input-wrapper">
      <Search aria-hidden="true" />
      <CommandPrimitive.Input className={cn("command-input", className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("command-list", className)} {...props} />;
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn("command-empty", className)} {...props} />;
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn("command-group", className)} {...props} />;
}

export function CommandItem({
  children,
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item className={cn("command-item", className)} {...props}>
      {children}
      <Check aria-hidden="true" className="command-item-check" />
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
        <TooltipPrimitive.Popup className={cn("tooltip-content", className)} {...props} />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
