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
});
