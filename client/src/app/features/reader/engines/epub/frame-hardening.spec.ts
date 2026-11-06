import { destroyNavigator } from './frame-hardening';

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
