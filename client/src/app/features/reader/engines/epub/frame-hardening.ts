import { getCssSelector } from 'css-selector-generator';

/** Readium waits for the shown frame to ack its hide before unmounting it, and a frame out of the page never
 *  answers: taken out first, every frame is torn down and its observers disconnected. */
export function destroyNavigator(navigator: { destroy(): Promise<void> }, container: HTMLElement): Promise<void> {
  container.querySelectorAll('iframe').forEach((f) => f.remove());
  return navigator.destroy();
}

/** The selector of an element of a frame, from the same selector kinds the toolkit's own anchors use. */
export function selectorOf(element: Element): string | undefined {
  try {
    return getCssSelector(element, {
      root: element.ownerDocument,
      selectors: ['tag', 'id', 'class', 'nthchild', 'nthoftype', 'attribute'],
    });
  } catch {
    return undefined;
  }
}
