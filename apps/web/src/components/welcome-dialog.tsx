import { CloudArrowDown } from "@phosphor-icons/react/CloudArrowDown";
import { FileText } from "@phosphor-icons/react/FileText";
import { Path } from "@phosphor-icons/react/Path";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import { TreeStructure } from "@phosphor-icons/react/TreeStructure";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SectionGrid,
  SectionGridItem,
} from "@mish/ui";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cx, tv } from "@mish/ui/tv";
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";

const welcomeStepCount = 4;

const welcomeStyles = tv({
  slots: {
    dialog: cx(
      "welcome-dialog flex h-[min(600px,calc(100vh_-_32px))] w-[min(640px,calc(100vw_-_32px))]",
      "max-h-none flex-col overflow-hidden",
    ),
    progress: cx(
      "welcome-progress flex min-h-10.5 flex-none items-center justify-center px-13 pt-3.5",
      "max-dialog-compact:px-11 [&_ol]:flex [&_ol]:list-none [&_ol]:gap-1.5 [&_ol]:p-0 [&_li]:h-1",
      "[&_li]:w-4.5 [&_li]:rounded-full [&_li]:bg-hairline [&_li[aria-current=step]]:bg-brand",
    ),
    cover: cx(
      "welcome-cover m-0 flex-none overflow-clip rounded-none border-0 bg-surface-soft",
      "[&_img]:block [&_img]:h-62.5 [&_img]:w-full [&_img]:object-cover",
      "max-dialog-compact:[&_img]:h-50",
    ),
    header: cx(
      "welcome-dialog-header min-h-22 flex-none border-b-0 px-6 pt-4.5 pb-4 max-dialog-compact:pl-4",
      "max-dialog-compact:pr-11 [&_.dialog-title]:text-title [&_.dialog-description]:mt-1.5",
      "[&_.dialog-description]:max-w-welcome-description [&_.dialog-description]:text-body",
      "[&_.dialog-description]:leading-5.25",
    ),
    body: cx(
      "welcome-dialog-body flex min-h-0 flex-1 flex-col gap-md overflow-y-auto px-6 pt-5 pb-4.5",
      "text-metadata leading-5 text-fg max-dialog-compact:min-h-auto max-dialog-compact:px-4",
    ),
    purpose: "welcome-cover-purpose max-w-welcome-purpose text-body leading-5.5 text-fg",
    conceptGrid: "welcome-concept-grid w-full overflow-clip [--section-grid-columns:1]",
    concept: "welcome-concept flex min-h-26 items-center gap-3 p-4 max-dialog-compact:min-h-auto",
    conceptIcon:
      "welcome-concept-icon grid size-6 flex-none place-items-center text-brand [&_svg]:size-5",
    conceptCopy: cx(
      "[&_h3]:text-body [&_h3]:font-semibold [&_h3]:text-ink [&_p]:mt-1.25 [&_p]:text-metadata",
      "[&_p]:leading-5 [&_p]:text-muted-foreground",
    ),
    guidance:
      "welcome-routing-guidance grid gap-2.5 [&_p]:text-body [&_p]:leading-5.5 [&_p]:text-fg",
    policy: cx(
      "welcome-policy-groups flex items-start gap-3 rounded-md border border-hairline",
      "bg-welcome-policy-background px-4 py-3.5 [&>svg]:mt-px [&>svg]:size-5.5 [&>svg]:flex-none",
      "[&>svg]:text-brand [&_h3]:text-body [&_h3]:font-semibold [&_h3]:text-ink [&_p]:mt-1.25",
      "[&_p]:text-metadata [&_p]:leading-5 [&_p]:text-muted-foreground [&_p+p]:mt-2",
    ),
    footer: "welcome-dialog-footer min-h-16.5 flex-none px-6 max-dialog-compact:px-4",
    dismiss: "welcome-dialog-dismiss mr-auto",
    primary: "welcome-dialog-primary w-33",
  },
});

interface WelcomeDialogProps {
  onOpenChange(open: boolean): void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function WelcomeConcept({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <SectionGridItem className={welcomeStyles().concept()}>
      <span aria-hidden="true" className={welcomeStyles().conceptIcon()}>
        {icon}
      </span>
      <div className={welcomeStyles().conceptCopy()}>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </SectionGridItem>
  );
}

export function WelcomeDialog({ onOpenChange, open, returnFocusRef }: WelcomeDialogProps) {
  const { LL } = useI18nContext();
  const settings = useSettings();
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [completion, setCompletion] = useState<Promise<boolean> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const steps = [
    {
      description: LL.onboarding.welcomeDescription(),
      title: LL.onboarding.welcomeTitle(),
    },
    {
      description: LL.onboarding.profileDescription(),
      title: LL.onboarding.profileTitle(),
    },
    {
      description: LL.onboarding.captureDescription(),
      title: LL.onboarding.captureTitle(),
    },
    {
      description: LL.onboarding.routingDescription(),
      title: LL.onboarding.routingTitle(),
    },
  ];
  const activeStep = steps[step] ?? steps[0];
  const finalStep = step === welcomeStepCount - 1;

  useEffect(() => {
    if (open && step > 0) titleRef.current?.focus({ preventScroll: true });
  }, [open, step]);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen || completion) return;
    setStep(0);
    onOpenChange(false);
    void settings.setOnboardingWelcomeState("dismiss");
  }

  function completeWelcome() {
    if (completion) return;
    const operation = settings.setOnboardingWelcomeState("complete");
    setCompletion(operation);
    void operation.then((completed) => {
      setCompletion(null);
      if (!completed) return;
      setStep(0);
      onOpenChange(false);
      setAnnouncement(LL.onboarding.completedAnnouncement());
    });
  }

  return (
    <>
      <Dialog disablePointerDismissal onOpenChange={changeOpen} open={open}>
        <DialogContent
          className={welcomeStyles().dialog()}
          closeLabel={LL.common.close()}
          data-welcome-step={step}
          finalFocus={returnFocusRef}
          initialFocus={primaryButtonRef}
        >
          {step > 0 ? (
            <div className={welcomeStyles().progress()}>
              <ol aria-label={LL.onboarding.progressLabel()}>
                {steps.slice(1).map(({ title }, index) => (
                  <li aria-current={index === step - 1 ? "step" : undefined} key={title}>
                    <span className="sr-only">{title}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {step === 0 ? (
            <figure className={welcomeStyles().cover()}>
              <img
                alt=""
                aria-hidden="true"
                height="640"
                src="/onboarding/welcome-cover.webp"
                width="960"
              />
            </figure>
          ) : null}
          <DialogHeader className={welcomeStyles().header()}>
            <div>
              <DialogTitle className="dialog-title" ref={titleRef} tabIndex={-1}>
                {activeStep.title}
              </DialogTitle>
              <DialogDescription className="dialog-description">
                {activeStep.description}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className={welcomeStyles().body()}>
            {step === 0 ? (
              <p className={welcomeStyles().purpose()}>{LL.onboarding.coverPurpose()}</p>
            ) : null}

            {step === 1 ? (
              <SectionGrid className={welcomeStyles().conceptGrid()} columns={1}>
                <WelcomeConcept
                  icon={<CloudArrowDown />}
                  title={LL.onboarding.profileProviderTitle()}
                >
                  {LL.onboarding.profileProviderDescription()}
                </WelcomeConcept>
                <WelcomeConcept icon={<FileText />} title={LL.onboarding.profileManualTitle()}>
                  {LL.onboarding.profileManualDescription()}
                </WelcomeConcept>
              </SectionGrid>
            ) : null}

            {step === 2 ? (
              <SectionGrid className={welcomeStyles().conceptGrid()} columns={1}>
                <WelcomeConcept
                  icon={<PlugsConnected />}
                  title={LL.onboarding.captureSystemTitle()}
                >
                  {LL.onboarding.captureSystemDescription()}
                </WelcomeConcept>
                <WelcomeConcept icon={<Path />} title={LL.onboarding.captureTunTitle()}>
                  {LL.onboarding.captureTunDescription()}
                </WelcomeConcept>
              </SectionGrid>
            ) : null}

            {step === 3 ? (
              <>
                <div className={welcomeStyles().guidance()}>
                  <p>{LL.onboarding.routingRuleGuidance()}</p>
                  <p>{LL.onboarding.routingGlobalFallback()}</p>
                </div>
                <div className={welcomeStyles().policy()}>
                  <TreeStructure aria-hidden="true" />
                  <div>
                    <h3>{LL.onboarding.policyGroupsTitle()}</h3>
                    <p>{LL.onboarding.policyGroupsDescription()}</p>
                    <p>{LL.onboarding.policyGroupsExample()}</p>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter className={welcomeStyles().footer()}>
            <DialogClose
              render={
                <Button
                  className={welcomeStyles().dismiss()}
                  disabled={Boolean(completion)}
                  variant="ghost"
                />
              }
            >
              {LL.onboarding.dismissWelcome()}
            </DialogClose>
            {step > 0 ? (
              <Button
                disabled={Boolean(completion)}
                onClick={() => setStep(step - 1)}
                variant="outline"
              >
                {LL.onboarding.back()}
              </Button>
            ) : null}
            {finalStep ? (
              <Button
                className={welcomeStyles().primary()}
                disabled={Boolean(completion)}
                loading={completion ?? false}
                loadingText={LL.onboarding.completeWelcome()}
                onClick={completeWelcome}
                ref={primaryButtonRef}
              >
                {LL.onboarding.completeWelcome()}
              </Button>
            ) : (
              <Button
                className={welcomeStyles().primary()}
                disabled={Boolean(completion)}
                onClick={() => setStep(step + 1)}
                ref={primaryButtonRef}
              >
                {step === 0 ? LL.onboarding.startTour() : LL.onboarding.next()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {announcement ? (
        <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
          {announcement}
        </p>
      ) : null}
    </>
  );
}
