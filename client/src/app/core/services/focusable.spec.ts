import { FOCUSABLE_SELECTOR, isFocusOptedOut } from './focusable.constants';

function html(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host.firstElementChild as HTMLElement;
}

describe('focus opt-outs', () => {
  it('takes a plain focusable', () => {
    const el = html('<button>ok</button>');
    expect(el.matches(FOCUSABLE_SELECTOR)).toBe(true);
    expect(isFocusOptedOut(el)).toBe(false);
  });

  it('rejects disabled, aria-hidden and tabindex=-1', () => {
    expect(isFocusOptedOut(html('<button disabled>x</button>'))).toBe(true);
    expect(isFocusOptedOut(html('<button aria-hidden="true">x</button>'))).toBe(true);
    expect(isFocusOptedOut(html('<a href="/x" tabindex="-1">x</a>'))).toBe(true);
  });

  it('rejects anything under an inert subtree, however deep', () => {
    const section = html('<div inert><div><a href="/x">x</a></div></div>');
    const link = section.querySelector('a') as HTMLElement;
    expect(isFocusOptedOut(link)).toBe(true);
    expect(isFocusOptedOut(section)).toBe(true);
  });

  it('takes the same element once its section is no longer inert', () => {
    const section = html('<div inert><a href="/x">x</a></div>');
    const link = section.querySelector('a') as HTMLElement;
    section.removeAttribute('inert');
    expect(isFocusOptedOut(link)).toBe(false);
  });
});
