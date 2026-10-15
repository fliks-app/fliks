import { UsersService } from './users.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import type { User } from './entities/user.entity';

const admin = { id: 1, isAdmin: true, permissions: ['manage:all'] } as User;

function make() {
  const userRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue({
        id: 2,
        enabled: true,
        isAdmin: false,
        roleId: 1,
        userRole: { id: 1 },
      }),
    save: jest.fn((u) => Promise.resolve(u)),
    remove: jest.fn(),
  };
  const libraryAccessRepo = {
    delete: jest.fn(),
    save: jest.fn(),
    create: jest.fn((r) => r),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: () => ({ where: () => ({ getRawMany: async () => [] }) }),
    }),
  };
  const engine = { revokeOwner: jest.fn() };
  const service = new UsersService(
    userRepo as never,
    {} as never,
    libraryAccessRepo as never,
    new CaslAbilityFactory(),
    {} as never,
    { dropConnectionsForUser: jest.fn() } as never,
    engine as never,
  );
  return { service, engine };
}

describe('UsersService: engine revocation', () => {
  it.each([
    ['deactivation', { enabled: false }],
    ['a library access change', { libraryIds: [1] }],
    ['an admin flag change', { isAdmin: true }],
  ])('revokes the user on %s', async (_n, dto) => {
    const { service, engine } = make();
    await service.update(2, dto, admin);
    expect(engine.revokeOwner).toHaveBeenCalledWith(2);
  });

  it('leaves the engine alone for a profile edit', async () => {
    const { service, engine } = make();
    await service.update(2, { email: 'a@b.c' }, admin);
    expect(engine.revokeOwner).not.toHaveBeenCalled();
  });

  it('revokes the user on deletion', async () => {
    const { service, engine } = make();
    await service.remove(2);
    expect(engine.revokeOwner).toHaveBeenCalledWith(2);
  });
});
