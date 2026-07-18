import { Desktop, Question, ShieldCheck } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toggle } from "@/components/ui/toggle";

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
        <Toggle
          className="capture-mode-button"
          onPressedChange={onSystemProxyChange}
          pressed={systemProxyEnabled}
          variant="outline"
        >
          <Desktop aria-hidden="true" data-icon="inline-start" size={15} weight="fill" />
          <span>系统代理</span>
        </Toggle>
        <Toggle
          className="capture-mode-button"
          onPressedChange={onTunChange}
          pressed={tunEnabled}
          variant="outline"
        >
          <ShieldCheck aria-hidden="true" data-icon="inline-start" size={15} weight="fill" />
          <span>虚拟网卡</span>
        </Toggle>
        <Button
          aria-label="了解系统代理和虚拟网卡的区别与启动记忆行为"
          className="capture-help-button"
          onClick={() => setHelpOpen(true)}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          <Question aria-hidden="true" data-icon="inline-start" size={15} weight="fill" />
        </Button>
      </div>

      <Dialog onOpenChange={setHelpOpen} open={helpOpen}>
        <DialogContent className="info-dialog" showCloseButton>
          <div className="dialog-header">
            <div>
              <DialogTitle className="dialog-title">系统代理与虚拟网卡</DialogTitle>
              <DialogDescription className="dialog-description">
                两种方式可以独立开启，也可以同时使用。
              </DialogDescription>
            </div>
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
                <h2>虚拟网卡</h2>
                <p>
                  通过虚拟网络接口接管更完整的 TCP/UDP 流量，需要额外权限，也可能影响少数网络工具。
                </p>
              </div>
            </section>
          </div>
          <div className="dialog-footer">
            <DialogClose
              render={<Button className="secondary-button" type="button" variant="outline" />}
            >
              知道了
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
