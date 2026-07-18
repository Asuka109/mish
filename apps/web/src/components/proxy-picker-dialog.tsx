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
import type { PolicyGroupDto, ProxyNodeDto } from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";

interface ProxyPickerDialogProps {
  group: PolicyGroupDto | null;
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
      <DialogContent className="proxy-picker-dialog" closeLabel={LL.common.close()}>
        <div className="proxy-picker-header">
          <div>
            <DialogTitle className="proxy-picker-title user-authored-label">
              {group.label}
            </DialogTitle>
            <DialogDescription className="proxy-picker-description">
              {LL.proxyPicker.description()}
            </DialogDescription>
          </div>
        </div>
        <Command className="proxy-picker-command">
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
                    className="proxy-picker-option"
                    data-checked={selected}
                    key={node.id}
                    onSelect={() => {
                      onSelect(node.id);
                      onOpenChange(false);
                    }}
                    value={`${node.label} ${node.protocol}`}
                  >
                    <span className="proxy-picker-option-copy">
                      <strong className="user-authored-label">{node.label}</strong>
                      <span>{node.protocol}</span>
                    </span>
                    <span className="proxy-picker-latency tabular">
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
