import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import {
  Desktop,
  Question,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";
import { ButtonGroup } from "./ui/button-group";

export function TrafficCaptureControl({
  onSystemProxyChange,
  onTunChange,
  systemProxyEnabled,
  tunEnabled,
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <div className="capture-control">
        <ButtonGroup aria-label="Traffic capture modes" className="capture-mode-group">
          <Button
            aria-pressed={systemProxyEnabled}
            className="capture-mode-button"
            onClick={() => onSystemProxyChange(!systemProxyEnabled)}
            type="button"
          >
            <Desktop aria-hidden="true" size={15} weight="fill" />
            <span>系统代理</span>
          </Button>
          <Button
            aria-pressed={tunEnabled}
            className="capture-mode-button"
            onClick={() => onTunChange(!tunEnabled)}
            type="button"
          >
            <ShieldCheck aria-hidden="true" size={15} weight="fill" />
            <span>增强模式（TUN）</span>
          </Button>
          <Button
            aria-label="了解系统代理和增强模式的区别"
            className="capture-help-button"
            onClick={() => setHelpOpen(true)}
            type="button"
          >
            <Question aria-hidden="true" size={15} weight="fill" />
          </Button>
        </ButtonGroup>
      </div>

      <Dialog.Root onOpenChange={setHelpOpen} open={helpOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Viewport className="modal-viewport">
            <Dialog.Popup className="info-dialog">
              <div className="dialog-header">
                <div>
                  <Dialog.Title className="dialog-title">系统代理与增强模式</Dialog.Title>
                  <Dialog.Description className="dialog-description">
                    两种方式可以独立开启，也可以同时使用。
                  </Dialog.Description>
                </div>
                <Dialog.Close aria-label="关闭说明" className="icon-button">
                  <X aria-hidden="true" size={16} />
                </Dialog.Close>
              </div>
              <div className="capture-explanations">
                <section className="capture-explanation">
                  <Desktop aria-hidden="true" size={18} />
                  <div>
                    <h2>系统代理</h2>
                    <p>轻量、兼容性好，适用于遵循 macOS 代理设置的应用；部分应用可能绕过它。</p>
                  </div>
                </section>
                <section className="capture-explanation">
                  <ShieldCheck aria-hidden="true" size={18} />
                  <div>
                    <h2>增强模式（TUN）</h2>
                    <p>通过虚拟网络接口接管更完整的 TCP/UDP 流量，需要额外权限，也可能影响少数网络工具。</p>
                  </div>
                </section>
              </div>
              <div className="dialog-footer">
                <Dialog.Close className="secondary-button" type="button">知道了</Dialog.Close>
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
