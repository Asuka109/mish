import { useI18nContext } from "../i18n/i18n-react";

export function StartupFailure() {
  const { LL } = useI18nContext();

  return (
    <main className="startup-failure" role="alert">
      <section>
        <p className="startup-failure__eyebrow">{LL.startupFailure.eyebrow()}</p>
        <h1>{LL.startupFailure.title()}</h1>
        <p>{LL.startupFailure.description()}</p>
      </section>
    </main>
  );
}
