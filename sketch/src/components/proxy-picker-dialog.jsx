import { Dialog } from "@base-ui/react/dialog";
import { Check, X } from "@phosphor-icons/react";

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
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="proxy-picker-backdrop" />
        <Dialog.Viewport className="proxy-picker-viewport">
          <Dialog.Popup className="proxy-picker-dialog">
            <div className="proxy-picker-header">
              <div>
                <Dialog.Title className="proxy-picker-title">{groupName}</Dialog.Title>
                <Dialog.Description className="proxy-picker-description">
                  Select a node for this policy group.
                </Dialog.Description>
              </div>
              <Dialog.Close aria-label="Close node picker" className="icon-button">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="proxy-picker-list">
              {options.map((option) => {
                const selected = option.id === selectedProxyId;

                return (
                  <Dialog.Close
                    aria-pressed={selected}
                    className="proxy-picker-option"
                    key={option.id}
                    onClick={() => onSelect(option.id)}
                  >
                    <span className="proxy-picker-option-copy">
                      <strong>{option.name}</strong>
                      <span>{option.protocol}</span>
                    </span>
                    <span className="proxy-picker-latency tabular">{option.latency} ms</span>
                    <span className="proxy-picker-check">
                      {selected ? <Check aria-hidden="true" size={14} weight="bold" /> : null}
                    </span>
                  </Dialog.Close>
                );
              })}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
