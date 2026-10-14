import { LibrariesService } from './libraries.service';

describe('LibrariesService.setUserAccess: engine revocation', () => {
  it('revokes only the users who lost the library', async () => {
    const engine = { revokeOwner: jest.fn() };
    const m = {
      delete: jest.fn(),
      create: (_e: unknown, r: unknown) => r,
      save: jest.fn(),
    };
    const service = new LibrariesService(
      {} as never,
      { find: async () => [{ userId: 1 }, { userId: 2 }] } as never,
      {} as never,
      { transaction: async (fn: (mm: unknown) => unknown) => fn(m) } as never,
      {} as never,
      engine as never,
    );

    await service.setUserAccess(5, [2, 3]);

    expect(engine.revokeOwner).toHaveBeenCalledTimes(1);
    expect(engine.revokeOwner).toHaveBeenCalledWith(1);
  });
});
