import { useState } from "react";

export const helper = "not a component";

export function InvalidComponent({ enabled }: { enabled: boolean }) {
  if (enabled) {
    useState(false);
  }
  return <img src="fixture.png" onClick={() => undefined} />;
}
