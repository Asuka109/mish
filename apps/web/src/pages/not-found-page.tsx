import { Link } from "react-router";
import { useI18nContext } from "../i18n/i18n-react";

export function NotFoundPage() {
  const { LL } = useI18nContext();

  return (
    <div className="grid min-h-full place-content-center gap-2.5 text-center text-(--color-text-muted)">
      <h1>{LL.notFound.title()}</h1>
      <p>{LL.notFound.description()}</p>
      <Link
        className="inline-flex items-center justify-center gap-1 rounded-(--radius-sm) p-1 text-(--text-metadata) leading-[18px] text-(--color-body) no-underline whitespace-nowrap hover:text-(--color-ink) hover:underline [&_svg]:size-[13px]"
        to="/status"
      >
        {LL.notFound.returnToStatus()}
      </Link>
    </div>
  );
}
