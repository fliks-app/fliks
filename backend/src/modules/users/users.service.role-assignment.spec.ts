import { ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import type { User } from './entities/user.entity';

/** `permissions` is a getter on the real entity; mirror it rather than set a plain property. */
function actor(permissions: string[]): User {
  return { id: 1, isAdmin: false, permissions } as User;
}

function makeService(target: Partial<User>) {
  const userRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 2, roleId: 1, userRole: { id: 1 }, ...target }),
    save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
    createQueryBuilder: jest.fn(),
  };
  const libraryAccessRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: () => ({ where: () => ({ getRawMany: async () => [] }) }),
    }),
  };
  const service = new UsersService(
    userRepo as never,
    { findOne: jest.fn() } as never,
    libraryAccessRepo as never,
    new CaslAbilityFactory(),
    {} as never,
    { dropConnectionsForUser: jest.fn() } as never,
  );
  return { service, userRepo };
}

describe('UsersService: assigning a role needs roles.manage', () => {
  it('refuses a role change from a user manager who cannot manage roles', async () => {
    const { service, userRepo } = makeService({});

    await expect(service.update(2, { roleId: 3 }, actor(['users.manage']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(userRepo.save).not.toHaveBeenCalled();
  });

  it('allows every other field for that same manager', async () => {
    const { service, userRepo } = makeService({ enabled: true });

    await service.update(2, { enabled: false }, actor(['users.manage']));

    expect(userRepo.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('allows the role change once roles.manage is held too', async () => {
    const { service, userRepo } = makeService({});

    await service.update(2, { roleId: 3 }, actor(['users.manage', 'roles.manage']));

    expect(userRepo.save).toHaveBeenCalledWith(expect.objectContaining({ roleId: 3 }));
  });

  it('ignores a resend of the role the user already has', async () => {
    const { service, userRepo } = makeService({});

    await service.update(2, { roleId: 1 }, actor(['users.manage']));

    expect(userRepo.save).toHaveBeenCalled();
  });

  it('refuses to pick a role when creating a user without roles.manage', async () => {
    const { service, userRepo } = makeService({});
    userRepo.findOne.mockResolvedValueOnce(null); // username is free

    await expect(
      service.create({ username: 'x', password: 'password1', roleId: 3 }, actor(['users.manage'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
