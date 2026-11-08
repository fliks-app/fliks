import { ToastService } from './toast.service';

describe('ToastService', () => {
  it('keeps a message the user closed quiet', () => {
    const toast = new ToastService();
    toast.error('boom');
    toast.close(toast.toasts()[0].id);
    toast.error('boom');
    expect(toast.toasts()).toHaveLength(0);
    toast.error('other');
    expect(toast.toasts()).toHaveLength(1);
  });
});
