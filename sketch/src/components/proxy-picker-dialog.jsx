import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProxyPickerDialog({
  groupName,
  onOpenChange,
  onSelect,
  open,
  options,
  selectedProxyId,
}) {
  if (!groupName) return null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="proxy-picker-dialog" showCloseButton>
        <div className="proxy-picker-header">
          <div>
            <DialogTitle className="proxy-picker-title user-authored-label">{groupName}</DialogTitle>
            <DialogDescription className="proxy-picker-description">
              Select a node for this policy group.
            </DialogDescription>
          </div>
        </div>

        <Command className="proxy-picker-command">
          <CommandInput aria-label="Search available nodes" placeholder="Search nodes" />
          <CommandList className="proxy-picker-list">
            <CommandEmpty>No matching nodes.</CommandEmpty>
            {options.map((option) => {
              const selected = option.id === selectedProxyId;

              return (
                <CommandItem
                  data-checked={selected}
                  className="proxy-picker-option"
                  key={option.id}
                  onSelect={() => {
                    onSelect(option.id);
                    onOpenChange(false);
                  }}
                  value={`${option.name} ${option.protocol}`}
                >
                  <span className="proxy-picker-option-copy">
                    <strong className="user-authored-label user-authored-label-node">
                      <span className="node-flag" aria-hidden="true">{option.emoji}</span>
                      {option.name}
                    </strong>
                    <span>{option.protocol}</span>
                  </span>
                  <span className="proxy-picker-latency tabular">{option.latency} ms</span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
