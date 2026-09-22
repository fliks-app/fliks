import { LiveTvAccessController } from './livetv-access.controller';

describe('LiveTvAccessController — restrictedGroups', () => {
  it('exposes the exempt list alongside the restricted-groups view, not just the restricted set', async () => {
    const restrictedGroupsView = jest.fn().mockResolvedValue([
      {
        name: 'News',
        automatic: false,
        vanishedSince: null,
        cleanupAt: null,
      },
    ]);
    const exemptGroups = jest.fn().mockResolvedValue(['XXX FR']);
    const controller = new LiveTvAccessController({
      restrictedGroupsView,
      exemptGroups,
    } as never);

    expect(await controller.restrictedGroups()).toEqual({
      groups: [
        {
          name: 'News',
          automatic: false,
          vanishedSince: null,
          cleanupAt: null,
        },
      ],
      exempt: ['XXX FR'],
    });
  });
});
