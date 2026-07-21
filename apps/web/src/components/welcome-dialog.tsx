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
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";

const welcomeStepCount = 4;

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
    <SectionGridItem className="welcome-concept">
      <span aria-hidden="true" className="welcome-concept-icon">
        {icon}
      </span>
      <div>
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
    if (open && step > 0) titleRef.current?.focus();
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
          className="welcome-dialog"
          closeLabel={LL.common.close()}
          data-welcome-step={step}
          finalFocus={returnFocusRef}
          initialFocus={primaryButtonRef}
        >
          {step > 0 ? (
            <div className="welcome-progress">
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
            <figure className="welcome-cover">
              <img
                alt=""
                aria-hidden="true"
                height="640"
                src="/onboarding/welcome-cover.webp"
                width="960"
              />
            </figure>
          ) : null}
          <DialogHeader className="welcome-dialog-header">
            <div>
              <DialogTitle className="dialog-title" ref={titleRef} tabIndex={-1}>
                {activeStep.title}
              </DialogTitle>
              <DialogDescription className="dialog-description">
                {activeStep.description}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="welcome-dialog-body">
            {step === 0 ? (
              <p className="welcome-cover-purpose">{LL.onboarding.coverPurpose()}</p>
            ) : null}

            {step === 1 ? (
              <SectionGrid className="welcome-concept-grid" columns={1}>
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
              <SectionGrid className="welcome-concept-grid" columns={1}>
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
                <div className="welcome-routing-guidance">
                  <p>{LL.onboarding.routingRuleGuidance()}</p>
                  <p>{LL.onboarding.routingGlobalFallback()}</p>
                </div>
                <div className="welcome-policy-groups">
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

          <DialogFooter className="welcome-dialog-footer">
            <DialogClose
              render={
                <Button
                  className="welcome-dialog-dismiss"
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
                className="welcome-dialog-primary"
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
                className="welcome-dialog-primary"
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
