/** Which element scrolls the page around `host`: a route owning its scroll
 *  carries `.page-scroller`, any other route scrolls the document (`null`). */
export function pageScrollOwner(host: Element | null | undefined): HTMLElement | null {
  return host?.closest<HTMLElement>('.page-scroller') ?? null;
}
