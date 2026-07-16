export function ButtonGroup({ className = "", orientation = "horizontal", ...props }) {
  return (
    <div
      className={`button-group ${className}`.trim()}
      data-orientation={orientation}
      data-slot="button-group"
      role="group"
      {...props}
    />
  );
}
