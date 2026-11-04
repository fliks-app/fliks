import { getCssSelector } from 'css-selector-generator';

/** Readium hard-codes `allow-scripts` on its content iframes; drop it as each one is added, before its first navigation.
 *  The selector generator the blocked script would have installed is then handed to every document the frame loads. */
export function sandboxContentFrames(container: HTMLElement): () => void {
  const harden = (f: HTMLIFrameElement) => {
    f.setAttribute('sandbox', 'allow-same-origin');
    f.addEventListener('load', () => f.contentWindow && provideCssSelectorGenerator(f.contentWindow));
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        (node instanceof HTMLIFrameElement ? [node] : node.querySelectorAll('iframe')).forEach(harden);
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** Readium waits for the shown frame to ack its hide before unmounting it, and a frame out of the page never
 *  answers: taken out first, every frame is torn down and its observers disconnected. */
export function destroyNavigator(navigator: { destroy(): Promise<void> }, container: HTMLElement): Promise<void> {
  container.querySelectorAll('iframe').forEach((f) => f.remove());
  return navigator.destroy();
}

type SelectorWindow = Window & {
  _readium_cssSelectorGenerator?: { getCssSelector: typeof getCssSelector };
};

/** Readium injects its generator as a script, which a frame without `allow-scripts` never runs. */
export function provideCssSelectorGenerator(frame: Window): void {
  (frame as SelectorWindow)._readium_cssSelectorGenerator = {
    getCssSelector: (element, options) => {
      const first = Array.isArray(element) ? element[0] : element;
      return getCssSelector(element, { root: first.ownerDocument, ...options });
    },
  };
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
