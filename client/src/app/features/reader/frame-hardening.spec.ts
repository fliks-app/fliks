import { provideCssSelectorGenerator, sandboxContentFrames } from './frame-hardening';

const frameWithToolkitSandbox = () => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  return frame;
};

describe('sandboxContentFrames', () => {
  it('replaces the toolkit sandbox with one that has no allow-scripts', async () => {
    const container = document.createElement('div');
    const stop = sandboxContentFrames(container);
    const frame = frameWithToolkitSandbox();
    container.append(frame);
    await Promise.resolve();
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    stop();
  });

  it('also covers a frame nested deeper in the container', async () => {
    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    container.append(wrapper);
    const stop = sandboxContentFrames(container);
    const frame = frameWithToolkitSandbox();
    wrapper.append(frame);
    await Promise.resolve();
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    stop();
  });

  it('stops once disconnected', async () => {
    const container = document.createElement('div');
    sandboxContentFrames(container)();
    const frame = frameWithToolkitSandbox();
    container.append(frame);
    await Promise.resolve();
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
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
