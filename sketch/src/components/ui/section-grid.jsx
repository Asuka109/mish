function joinClassNames(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export function SectionGrid({
  as: Component = "div",
  children,
  className,
  columns = 1,
  style,
  ...props
}) {
  return (
    <Component
      className={joinClassNames("section-grid", className)}
      style={{ ...style, "--section-grid-columns": columns }}
      {...props}
    >
      {children}
    </Component>
  );
}

export function SectionGridItem({
  as: Component = "div",
  children,
  className,
  columnSpan = 1,
  rowSpan = 1,
  style,
  ...props
}) {
  return (
    <Component
      className={joinClassNames("section-grid-item", className)}
      style={{
        ...style,
        "--section-grid-column-span": columnSpan,
        "--section-grid-row-span": rowSpan,
      }}
      {...props}
    >
      {children}
    </Component>
  );
}
