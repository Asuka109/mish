import { Link } from "react-router";
import { useI18nContext } from "../i18n/i18n-react";

export function NotFoundPage() {
  const { LL } = useI18nContext();

  return (
    <div className="not-found-page">
      <h1>{LL.notFound.title()}</h1>
      <p>{LL.notFound.description()}</p>
      <Link className="text-link" to="/status">
        {LL.notFound.returnToStatus()}
      </Link>
    </div>
  );
}
