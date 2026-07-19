import {
  createContext,
  useContext,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useAppearance, type EffectiveWindowSurface } from "../appearance";

export type SurfaceRole = "window" | "content";
export type SurfaceRendering = "opaque" | "material";

interface SurfaceScopeValue {
  rendering: SurfaceRendering;
  role: SurfaceRole;
}

interface SurfaceScopeProps extends HTMLAttributes<HTMLElement> {
  as?: Extract<ElementType, "aside" | "div" | "main" | "section">;
  children: ReactNode;
  surfaceRole: SurfaceRole;
}

const SurfaceScopeContext = createContext<SurfaceScopeValue>({
  rendering: "opaque",
  role: "content",
});

function resolveSurfaceRendering(
  role: SurfaceRole,
  effectiveWindowSurface: EffectiveWindowSurface,
): SurfaceRendering {
  if (role === "content") return "opaque";
  return effectiveWindowSurface === "native-material" ? "material" : "opaque";
}

export function SurfaceScope({
  as: Element = "div",
  children,
  surfaceRole,
  ...props
}: SurfaceScopeProps) {
  const { effectiveWindowSurface } = useAppearance();
  const value = {
    rendering: resolveSurfaceRendering(surfaceRole, effectiveWindowSurface),
    role: surfaceRole,
  } satisfies SurfaceScopeValue;

  return (
    <SurfaceScopeContext.Provider value={value}>
      <Element {...props} data-surface-rendering={value.rendering} data-surface-role={value.role}>
        {children}
      </Element>
    </SurfaceScopeContext.Provider>
  );
}

export function useSurfaceScope() {
  return useContext(SurfaceScopeContext);
}
