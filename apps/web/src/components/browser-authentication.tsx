import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Spinner } from "@mish/ui";
import { ShieldCheck } from "@phosphor-icons/react";
import { tv } from "tailwind-variants";
import { useI18nContext } from "../i18n/i18n-react";
import {
  BrowserPairingError,
  completeBrowserPairing,
  requestBrowserPairing,
  type BrowserPairingChallenge,
} from "../platform/runtime-bootstrap";

interface BrowserAuthenticationProps {
  complete?: typeof completeBrowserPairing;
  onAuthenticated?: () => void;
  request?: typeof requestBrowserPairing;
}

const authenticationStyles = tv({
  slots: {
    page: "fixed inset-0 flex items-center justify-center bg-surface-soft p-xl font-sans text-ink",
    card: "w-[min(100%,440px)] rounded-lg border border-hairline bg-canvas p-xl shadow-panel [&_h1]:my-xs [&_h1]:mb-sm [&_h1]:text-title [&_h1]:font-semibold [&_p]:m-0 [&_p]:text-body [&_p]:text-fg",
    icon: "flex size-11 items-center justify-center rounded-md bg-accent text-focus-accent mb-md [&_svg]:size-6",
    eyebrow: "text-metadata! text-muted-foreground!",
    form: "mt-lg [&_label]:mb-xs [&_label]:block [&_label]:text-body [&_label]:font-semibold [&_label]:text-ink [&_.ui-input]:w-full [&_.ui-input]:font-mono [&_.ui-input]:text-2xl [&_.ui-input]:tracking-pin [&_.ui-input]:text-center [&_.ui-button]:mt-md [&_.ui-button]:w-full",
    status: "mt-lg flex items-center gap-sm text-fg",
    recovery: "mt-lg [&_.ui-button]:mt-md [&_.ui-button]:w-full",
    hint: "mt-xs! text-metadata! text-muted-foreground!",
    error: "mt-sm! text-error!",
  },
});

export function BrowserAuthentication({
  complete = completeBrowserPairing,
  onAuthenticated = () => window.location.reload(),
  request = requestBrowserPairing,
}: BrowserAuthenticationProps) {
  const { LL } = useI18nContext();
  const [challenge, setChallenge] = useState<BrowserPairingChallenge | null>(null);
  const [error, setError] = useState<BrowserPairingError["kind"] | null>(null);
  const [pin, setPin] = useState("");
  const [starting, setStarting] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const start = async () => {
    setChallenge(null);
    setError(null);
    setPin("");
    setStarting(true);
    try {
      setChallenge(await request());
    } catch (failure) {
      setError(failure instanceof BrowserPairingError ? failure.kind : "unavailable");
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    void start();
    // Pairing is intentionally requested once when this authentication view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge || !/^\d{6}$/.test(pin) || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await complete(challenge.challengeId, pin);
      onAuthenticated();
    } catch (failure) {
      setError(failure instanceof BrowserPairingError ? failure.kind : "unavailable");
    } finally {
      setSubmitting(false);
    }
  };

  const recoverable = error === "expired" || error === "locked" || error === "unavailable";
  const errorMessage = error ? LL.browserAuthentication.errors[error]() : null;

  return (
    <main className={authenticationStyles().page({ className: "browser-authentication" })}>
      <section
        aria-labelledby="browser-authentication-title"
        className={authenticationStyles().card()}
      >
        <div aria-hidden="true" className={authenticationStyles().icon()}>
          <ShieldCheck weight="duotone" />
        </div>
        <p className={authenticationStyles().eyebrow()}>{LL.browserAuthentication.eyebrow()}</p>
        <h1 id="browser-authentication-title">{LL.browserAuthentication.title()}</h1>
        <p>{LL.browserAuthentication.description()}</p>

        {starting ? (
          <div className={authenticationStyles().status()} role="status">
            <Spinner />
            <span>{LL.browserAuthentication.requesting()}</span>
          </div>
        ) : challenge ? (
          <form className={authenticationStyles().form()} onSubmit={submit}>
            <label htmlFor="browser-pairing-pin">{LL.browserAuthentication.pinLabel()}</label>
            <Input
              id="browser-pairing-pin"
              autoComplete="one-time-code"
              autoFocus
              disabled={submitting || recoverable}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              pattern="[0-9]{6}"
              placeholder="000000"
              value={pin}
            />
            <p className={authenticationStyles().hint()}>
              {LL.browserAuthentication.pinHint({ seconds: challenge.expiresInSeconds })}
            </p>
            {errorMessage && !recoverable ? (
              <p className={authenticationStyles().error()} role="alert">
                {errorMessage}
              </p>
            ) : null}
            <Button
              disabled={!/^\d{6}$/.test(pin) || recoverable}
              loading={submitting}
              loadingText={LL.browserAuthentication.connecting()}
              type="submit"
            >
              {LL.browserAuthentication.connect()}
            </Button>
          </form>
        ) : null}

        {!starting && recoverable ? (
          <div className={authenticationStyles().recovery()}>
            {errorMessage ? (
              <p className={authenticationStyles().error()} role="alert">
                {errorMessage}
              </p>
            ) : null}
            <Button onClick={() => void start()} variant="outline">
              {LL.browserAuthentication.requestAgain()}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
