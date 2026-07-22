import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@mish/ui";
import type { ProxyNodeDto, SelectorPolicyGroupDto } from "@mish/contracts";
import { tv } from "tailwind-variants";
import { useI18nContext } from "../i18n/i18n-react";

const proxyPickerStyles = tv({
  slots: {
    dialog:
      "max-h-[min(520px,calc(100vh_-_48px))] w-[min(420px,calc(100vw_-_32px))] overflow-hidden",
    header:
      "flex min-h-[74px] items-center border-b border-(--color-hairline) py-[13px] pr-11 pl-4",
    title: "text-(--text-body) font-(--font-weight-heading)",
    description: "mt-[3px] text-(--text-metadata) leading-[18px] text-(--color-text-muted)",
    option:
      "grid min-h-14 grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 rounded-none border-0 border-b border-(--color-hairline) px-[14px] py-0 pr-[14px] pl-4 text-(--color-body) outline-none last:border-b-0 data-[selected=true]:bg-(--color-accent) data-[selected=true]:text-(--color-ink) data-[checked=true]:bg-(--color-accent) data-[checked=true]:text-(--color-ink) data-[checked=true]:[&_.command-item-check]:opacity-100",
    optionCopy:
      "grid min-w-0 gap-0.5 [&_strong]:truncate [&_strong]:text-(--text-body) [&_strong]:font-(--font-weight-control) [&_span]:text-(--text-metadata) [&_span]:text-(--color-text-muted)",
    latency: "text-(--text-metadata) text-(--color-success-text)",
  },
});

interface ProxyPickerDialogProps {
  group: SelectorPolicyGroupDto | null;
  nodes: ProxyNodeDto[];
  onOpenChange(open: boolean): void;
  onSelect(nodeId: string): void;
  open: boolean;
}

export function ProxyPickerDialog({
  group,
  nodes,
  onOpenChange,
  onSelect,
  open,
}: ProxyPickerDialogProps) {
  const { LL } = useI18nContext();
  if (!group) return null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={proxyPickerStyles().dialog()} closeLabel={LL.common.close()}>
        <div className={proxyPickerStyles().header()}>
          <div>
            <DialogTitle className={`${proxyPickerStyles().title()} user-authored-label`}>
              {group.label}
            </DialogTitle>
            <DialogDescription className={proxyPickerStyles().description()}>
              {LL.proxyPicker.description()}
            </DialogDescription>
          </div>
        </div>
        <Command>
          <CommandInput
            aria-label={LL.proxyPicker.searchAria()}
            placeholder={LL.proxyPicker.searchPlaceholder()}
          />
          <CommandList className="proxy-picker-list">
            <CommandEmpty>{LL.proxyPicker.empty()}</CommandEmpty>
            <CommandGroup>
              {nodes.map((node) => {
                const selected = node.id === group.selectedChildId;
                return (
                  <CommandItem
                    className={proxyPickerStyles().option()}
                    data-checked={selected}
                    key={node.id}
                    onSelect={() => {
                      onSelect(node.id);
                      onOpenChange(false);
                    }}
                    value={`${node.label} ${node.protocol}`}
                  >
                    <span className={proxyPickerStyles().optionCopy()}>
                      <strong className="user-authored-label">{node.label}</strong>
                      <span>{node.protocol}</span>
                    </span>
                    <span className={`${proxyPickerStyles().latency()} tabular-nums`}>
                      {node.latencyMilliseconds === null
                        ? LL.common.unavailable()
                        : `${node.latencyMilliseconds} ms`}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
