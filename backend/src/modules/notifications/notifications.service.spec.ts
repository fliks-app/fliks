import { bridgeFetch } from '../bridge/server-bridge';
import { NotificationsService } from './notifications.service';

jest.mock('../bridge/server-bridge');
const fetchMock = jest.mocked(bridgeFetch);

describe('NotificationsService (bridge client)', () => {
  const service = new NotificationsService();

  beforeEach(() => fetchMock.mockReset());

  it('posts the event and payload to the dispatch bridge', async () => {
    fetchMock.mockResolvedValue(undefined);
    await service.dispatch('request.created', { title: 'Dune' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/internal/notifications/dispatch',
      expect.objectContaining({
        method: 'POST',
        body: { event: 'request.created', payload: { title: 'Dune' } },
      }),
    );
  });

  it('dispatch never rejects, dispatchStrict does', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await expect(
      service.dispatch('request.created', {}),
    ).resolves.toBeUndefined();
    await expect(service.dispatchStrict('request.created', {})).rejects.toThrow(
      'down',
    );
  });
});
