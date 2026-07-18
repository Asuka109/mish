import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Command as CommandPrimitive } from "cmdk";
import { Check, Search, X } from "lucide-react";
import {
  createContext,
  useContext,
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends ComponentProps<typeof ButtonPrimitive> {
  size?: "default" | "sm" | "icon-sm";
  variant?: "default" | "outline" | "ghost" | "destructive";
}

export function Button({
  className,
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      className={cn("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)}
      data-slot="button"
      {...props}
    />
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "outline";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn("ui-badge", `ui-badge--${variant}`, className)}
      data-slot="badge"
      {...props}
    />
  );
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
  variant?: "default" | "outline";
}

export function Toggle({ className, variant = "default", ...props }: ToggleProps) {
  return (
    <TogglePrimitive
      className={cn("ui-toggle", `ui-toggle--${variant}`, className)}
      data-slot="toggle"
      {...props}
    />
  );
}

interface ToggleGroupContextValue {
  spacing: number;
  variant: "default" | "outline";
}

const ToggleGroupContext = createContext<ToggleGroupContextValue>({
  spacing: 2,
  variant: "default",
});

export interface ToggleGroupProps extends ComponentProps<typeof ToggleGroupPrimitive> {
  spacing?: number;
  variant?: "default" | "outline";
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
      className={cn("ui-toggle-group", className)}
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
      className={cn("ui-toggle-group-item", className)}
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
  return <InputPrimitive className={cn("ui-input", className)} data-slot="input" {...props} />;
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
  return <div {...props} className={cn("ui-empty", props.className)} data-slot="empty" />;
}

export function EmptyHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ui-empty-header", props.className)} />;
}

export function EmptyTitle(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ui-empty-title", props.className)} />;
}

export function EmptyDescription(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ui-empty-description", props.className)} />;
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
