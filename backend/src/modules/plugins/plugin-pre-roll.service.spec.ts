import { PluginPreRollService } from './plugin-pre-roll.service';
import { PRE_ROLL_ITEMS_MAX } from '../../common/plugin-contract';

function fakeRegistry(winner: { pluginId: string; route: string } | undefined) {
  return { preRollRoute: jest.fn().mockReturnValue(winner) };
}

function fakeProcessService(callPlugin: jest.Mock) {
  return { callPlugin };
}

const ASK = { mediaFileId: 1, mediaId: 10, principal: { kind: 'system' as const } };

describe('PluginPreRollService.ask', () => {
  it('returns an empty list when no plugin declares ui.player', async () => {
    const service = new PluginPreRollService(fakeRegistry(undefined) as never, fakeProcessService(jest.fn()) as never);

    expect(await service.ask(ASK)).toEqual([]);
  });

  it('returns an empty list, never throws, when the call rejects (stopped plugin / timeout)', async () => {
    const callPlugin = jest.fn().mockRejectedValue(new Error('plugin "fliks.a" is not running'));
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    await expect(service.ask(ASK)).resolves.toEqual([]);
  });

  it('returns an empty list on a non-200 status', async () => {
    const callPlugin = jest.fn().mockResolvedValue({ status: 500, body: [{ mediaFileId: 5 }] });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    expect(await service.ask(ASK)).toEqual([]);
  });

  it('returns an empty list on a malformed (non-array) body', async () => {
    const callPlugin = jest.fn().mockResolvedValue({ status: 200, body: { not: 'an array' } });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    expect(await service.ask(ASK)).toEqual([]);
  });

  it('drops entries that are not a positive-integer mediaFileId, keeps the rest', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      body: [{ mediaFileId: 5 }, { mediaFileId: -1 }, { mediaFileId: 'x' }, { mediaFileId: 1.5 }, {}],
    });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    expect(await service.ask(ASK)).toEqual([{ mediaFileId: 5 }]);
  });

  it('truncates a response longer than the published cap', async () => {
    // Ids start above ASK's own mediaFileId, so this measures the cap and nothing else.
    const body = Array.from({ length: PRE_ROLL_ITEMS_MAX + 10 }, (_, i) => ({ mediaFileId: i + 2 }));
    const callPlugin = jest.fn().mockResolvedValue({ status: 200, body });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    const result = await service.ask(ASK);
    expect(result).toHaveLength(PRE_ROLL_ITEMS_MAX);
    expect(result).toEqual(Array.from({ length: PRE_ROLL_ITEMS_MAX }, (_, i) => ({ mediaFileId: i + 2 })));
  });

  it('calls the winning plugin route as a POST carrying the ask, delegated to the caller', async () => {
    const callPlugin = jest.fn().mockResolvedValue({ status: 200, body: [] });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    await service.ask({ mediaFileId: 1, mediaId: 10, episodeId: 3, principal: { kind: 'delegated', userId: 7 } });

    expect(callPlugin).toHaveBeenCalledWith(
      'fliks.a',
      'http',
      expect.objectContaining({
        method: 'POST',
        path: '/pre-roll',
        body: { mediaFileId: 1, mediaId: 10, episodeId: 3 },
        principal: { kind: 'delegated', userId: 7 },
      }),
      expect.any(Number),
    );
  });

  it('drops the main item and any repeat, so nothing plays twice', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      body: [{ mediaFileId: 1 }, { mediaFileId: 7 }, { mediaFileId: 7 }, { mediaFileId: 9 }],
    });
    const service = new PluginPreRollService(
      fakeRegistry({ pluginId: 'fliks.a', route: '/pre-roll' }) as never,
      fakeProcessService(callPlugin) as never,
    );

    // ASK's own mediaFileId is 1: pre-rolling the main item would play it twice.
    await expect(service.ask(ASK)).resolves.toEqual([{ mediaFileId: 7 }, { mediaFileId: 9 }]);
  });
});
