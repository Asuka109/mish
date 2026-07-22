import { Link } from "react-router";
import { cx } from "tailwind-variants";
import { useI18nContext } from "../i18n/i18n-react";

export function NotFoundPage() {
  const { LL } = useI18nContext();

  return (
    <div className="grid min-h-full place-content-center gap-2.5 text-center text-muted-foreground">
      <h1>{LL.notFound.title()}</h1>
      <p>{LL.notFound.description()}</p>
      <Link
        className={cx(
          "inline-flex items-center justify-center gap-1 rounded-sm p-1",
          "text-metadata leading-4.5 text-fg no-underline whitespace-nowrap",
          "hover:text-ink hover:underline [&_svg]:size-3.25",
        )}
        to="/status"
      >
        {LL.notFound.returnToStatus()}
      </Link>
    </div>
  );
}
