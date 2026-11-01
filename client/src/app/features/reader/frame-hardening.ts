import { getCssSelector } from 'css-selector-generator';

/** Readium hard-codes `allow-scripts` on its content iframes; drop it as each one is added, before its first navigation. */
export function sandboxContentFrames(container: HTMLElement): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement) node.setAttribute('sandbox', 'allow-same-origin');
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
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
