import {
  FOCUSABLE_SELECTOR,
  centerInScroller,
  isFocusOptedOut,
  scrollSelectedIntoView,
} from './focusable.constants';

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

  it('rejects the full-screen click-outside button of a modal backdrop', () => {
    const form = html('<form class="modal-backdrop"><button>close</button></form>');
    expect(isFocusOptedOut(form.querySelector('button') as HTMLElement)).toBe(true);
  });

  it('takes the same element once its section is no longer inert', () => {
    const section = html('<div inert><a href="/x">x</a></div>');
    const link = section.querySelector('a') as HTMLElement;
    section.removeAttribute('inert');
    expect(isFocusOptedOut(link)).toBe(false);
  });
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** A 300px scroller at viewport y=100 holding one 40px row, scrolled to `scrollTop`; the
 *  row sits `rowTop` px below the scroller's top edge before scrolling. */
function list(opts: { rowTop: number; scrollTop?: number; header?: number }) {
  const box = document.createElement('div');
  box.style.overflowY = 'auto';
  const scrollTop = opts.scrollTop ?? 0;
  Object.defineProperties(box, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 1000 },
    scrollTop: { value: scrollTop },
  });
  box.getBoundingClientRect = () => rect(100, 300);
  const scrollTo = vi.fn();
  box.scrollTo = scrollTo as unknown as typeof box.scrollTo;
  if (opts.header) {
    const head = document.createElement('div');
    head.style.position = 'sticky';
    head.getBoundingClientRect = () => rect(100, opts.header!);
    box.appendChild(head);
  }
  const row = document.createElement('button');
  row.setAttribute('aria-current', 'true');
  row.getBoundingClientRect = () => rect(100 + opts.rowTop - scrollTop, 40);
  box.appendChild(row);
  document.body.appendChild(box);
  return { box, row, scrollTo };
}

describe('centerInScroller', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('centers a row below the fold', () => {
    const { row, scrollTo } = list({ rowTop: 600 });
    centerInScroller(row);
    // row centre sits 720 on screen, band centre 250: scroll down by 470
    expect(scrollTo).toHaveBeenCalledWith({ top: 470, behavior: 'instant' });
  });

  it('leaves a fully visible row alone', () => {
    const { row, scrollTo } = list({ rowTop: 100 });
    centerInScroller(row);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('treats a row under the sticky header as hidden and centers it in the space left', () => {
    const { row, scrollTo } = list({ rowTop: 220, scrollTop: 200, header: 60 });
    centerInScroller(row);
    // visible band is 160..400 (centre 280), the row spans 120..160: scroll up by 140
    expect(scrollTo).toHaveBeenCalledWith({ top: 60, behavior: 'instant' });
  });

  it('does nothing when no ancestor overflows, so the page is never scrolled', () => {
    const { box, row, scrollTo } = list({ rowTop: 600 });
    box.style.overflowY = 'visible';
    centerInScroller(row);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('scrollSelectedIntoView', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('centers the current row of the root', () => {
    const { box, scrollTo } = list({ rowTop: 600 });
    scrollSelectedIntoView(box);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without a selected row', () => {
    const { box, row, scrollTo } = list({ rowTop: 600 });
    row.removeAttribute('aria-current');
    scrollSelectedIntoView(box);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('also finds the row SelectedOptionDirective marks', () => {
    const { box, row, scrollTo } = list({ rowTop: 600 });
    row.removeAttribute('aria-current');
    row.setAttribute('aria-disabled', 'true');
    scrollSelectedIntoView(box);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
