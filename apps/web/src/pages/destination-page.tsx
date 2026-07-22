import { CirclesFour } from "@phosphor-icons/react/CirclesFour";
import { FileText } from "@phosphor-icons/react/FileText";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ListBullets } from "@phosphor-icons/react/ListBullets";
import { PlugsConnected } from "@phosphor-icons/react/PlugsConnected";
import type { Icon } from "@phosphor-icons/react/lib";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";

type Destination = "routes" | "profiles" | "traffic" | "events" | "settings";

interface DestinationDefinition {
  description: string;
  icon: Icon;
  items: Array<{ label: string; detail: string }>;
  prerequisite: string;
  title: string;
}

const destinationIcons: Record<Destination, Icon> = {
  events: ListBullets,
  profiles: FileText,
  routes: CirclesFour,
  settings: GearSix,
  traffic: PlugsConnected,
};

function getDefinition(LL: TranslationFunctions, destination: Destination): DestinationDefinition {
  const copy = LL.destination[destination];
  return {
    description: copy.description(),
    icon: destinationIcons[destination],
    items: [
      { detail: copy.itemOneDetail(), label: copy.itemOneLabel() },
      { detail: copy.itemTwoDetail(), label: copy.itemTwoLabel() },
      { detail: copy.itemThreeDetail(), label: copy.itemThreeLabel() },
    ],
    prerequisite: copy.prerequisite(),
    title: copy.title(),
  };
}

interface DestinationPageProps {
  destination: Destination;
}

export function DestinationPage({ destination }: DestinationPageProps) {
  const { LL } = useI18nContext();
  const definition = getDefinition(LL, destination);
  const DestinationIcon = definition.icon;

  return (
    <div className="destination-page">
      <section className="destination-intro">
        <div aria-hidden="true" className="destination-icon">
          <DestinationIcon />
        </div>
        <div>
          <span className="foundation-label">{LL.destination.foundation()}</span>
          <h1>{definition.title}</h1>
          <p>{definition.description}</p>
        </div>
      </section>

      <section aria-labelledby={`${destination}-structure`} className="destination-structure">
        <div className="section-heading destination-heading">
          <div className="section-heading-copy">
            <h2 id={`${destination}-structure`}>{LL.destination.plannedStructure()}</h2>
            <p>{LL.destination.plannedDescription()}</p>
          </div>
        </div>
        <div className="destination-list">
          {definition.items.map((item) => (
            <div className="destination-row" key={item.label}>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
              <span className="coming-next">{LL.destination.partTwo()}</span>
            </div>
          ))}
        </div>
      </section>

      <aside className="prerequisite-note">
        <strong>{LL.destination.currentState()}</strong>
        <p>{definition.prerequisite}</p>
      </aside>
    </div>
  );
}
