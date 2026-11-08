// Whether motion should be kept to a minimum: the person turned it down in Appearance, or
// their system asks for less. The stylesheets and Motion follow both too.

export function motionReduced(): boolean {
  return document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
}
