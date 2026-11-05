import { destroyNavigator, provideCssSelectorGenerator, provideFrameSelectors } from './frame-hardening';

const generatorOf = (frame: HTMLIFrameElement) =>
  (frame.contentWindow as { _readium_cssSelectorGenerator?: unknown })._readium_cssSelectorGenerator;

const loadIn = async (container: HTMLElement, parent: HTMLElement = container) => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  parent.append(frame);
  await Promise.resolve();
  frame.dispatchEvent(new Event('load'));
  return frame;
};

describe('provideFrameSelectors', () => {
  it('hands each document a frame loads the selector generator, and keeps the toolkit sandbox', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const stop = provideFrameSelectors(container);
    const frame = await loadIn(container);
    expect(generatorOf(frame)).toBeDefined();
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
    stop();
    container.remove();
  });

  it('also covers a frame nested deeper in the container', async () => {
    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    container.append(wrapper);
    document.body.append(container);
    const stop = provideFrameSelectors(container);
    expect(generatorOf(await loadIn(container, wrapper))).toBeDefined();
    stop();
    container.remove();
  });

  it('stops once disconnected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    provideFrameSelectors(container)();
    expect(generatorOf(await loadIn(container))).toBeUndefined();
    container.remove();
  });
});

describe('provideCssSelectorGenerator', () => {
  it('hands the frame a generator whose selector finds the element again', () => {
    const doc = document.implementation.createHTMLDocument('chapter');
    doc.body.innerHTML = '<div><p>a</p><p>b</p><p>c</p></div><section><p>d</p><p id="x">e</p></section>';
    const frame = {} as Window & {
      _readium_cssSelectorGenerator?: { getCssSelector: (e: Element, o?: object) => string };
    };
    provideCssSelectorGenerator(frame);
    const generator = frame._readium_cssSelectorGenerator!;
    for (const el of Array.from(doc.querySelectorAll('p'))) {
      const selector = generator.getCssSelector(el, {
        selectors: ['tag', 'id', 'class', 'nthchild', 'nthoftype', 'attribute'],
      });
      expect(doc.querySelectorAll(selector)).toHaveLength(1);
      expect(doc.querySelector(selector)).toBe(el);
    }
  });
});

describe('destroyNavigator', () => {
  it('takes the frames out of the page before the toolkit tears them down', async () => {
    const container = document.createElement('div');
    const frame = document.createElement('iframe');
    container.appendChild(frame);
    let parentAtDestroy: Element | null | undefined;
    await destroyNavigator({ destroy: async () => void (parentAtDestroy = frame.parentElement) }, container);
    expect(parentAtDestroy).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });
});
