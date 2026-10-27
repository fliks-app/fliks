import { DismissableStackService } from './dismissable-stack.service';

describe('DismissableStackService', () => {
  it('keeps a layer registered while its callback returns true', () => {
    const svc = new DismissableStackService();
    let step = 0;
    // A multi-panel dropdown: first Back steps to the parent panel, second closes.
    svc.push(() => (++step === 1 ? true : undefined));

    expect(svc.dismissTop()).toBe(true);
    expect(svc.hasAny()).toBe(true);
    expect(svc.dismissTop()).toBe(true);
    expect(svc.hasAny()).toBe(false);
    expect(svc.dismissTop()).toBe(false);
    expect(step).toBe(2);
  });

  it('pops the top layer and leaves the ones below', () => {
    const svc = new DismissableStackService();
    const order: string[] = [];
    svc.push(() => {
      order.push('bottom');
    });
    svc.push(() => {
      order.push('top');
    });

    svc.dismissTop();
    svc.dismissTop();
    expect(order).toEqual(['top', 'bottom']);
    expect(svc.hasAny()).toBe(false);
  });

  it('stacks an open dialog over a layer opened before it, and skips one dropped while open', async () => {
    const svc = new DismissableStackService();
    let panelOpen = true;
    svc.push(() => {
      panelOpen = false;
    });
    const dialog = document.body.appendChild(document.createElement('dialog'));
    // jsdom has no HTMLDialogElement.close().
    dialog.close = () => dialog.removeAttribute('open');
    dialog.setAttribute('open', '');
    await Promise.resolve();

    svc.dismissTop();
    expect([dialog.open, panelOpen]).toEqual([false, true]);
    await Promise.resolve();

    const dropped = document.body.appendChild(document.createElement('dialog'));
    dropped.setAttribute('open', '');
    await Promise.resolve();
    dropped.remove();
    svc.dismissTop();
    expect(panelOpen).toBe(false);
    dialog.remove();
  });
});
