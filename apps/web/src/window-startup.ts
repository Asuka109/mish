/** Remove the HTML loading marker once the renderer has mounted. */
export function revealStartupSurface(): void {
  document.querySelector(".startup-placeholder")?.remove();
}

revealStartupSurface();
