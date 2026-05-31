import { NotFoundException } from '@nestjs/common';
import { StreamingService } from './streaming.service';
import type { User } from '../users/entities/user.entity';

describe('StreamingService.assertLibraryAccess', () => {
  const user = { id: 1 } as User;

  function make(accessible: number[] | null) {
    const libraries = {
      getAccessibleLibraryIds: jest.fn().mockResolvedValue(accessible),
    };
    return new StreamingService(
      {} as never,
      {} as never,
      libraries as never,
    );
  }

  it('no-ops for an internal caller (no user), even if the library would be denied', async () => {
    const svc = make([99]);
    await expect(
      svc.assertLibraryAccess(5, undefined, 'nf'),
    ).resolves.toBeUndefined();
  });

  it('allows access when getAccessibleLibraryIds returns null (full-access / admin)', async () => {
    const svc = make(null);
    await expect(
      svc.assertLibraryAccess(5, user, 'nf'),
    ).resolves.toBeUndefined();
  });

  it('allows a library the user can access', async () => {
    const svc = make([1, 5]);
    await expect(
      svc.assertLibraryAccess(5, user, 'nf'),
    ).resolves.toBeUndefined();
  });

  it('throws NotFound for a library outside the user access list (IDOR guard)', async () => {
    const svc = make([1, 2]);
    await expect(svc.assertLibraryAccess(5, user, 'nf')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound when the resource has no library and access is restricted', async () => {
    const svc = make([1, 2]);
    await expect(svc.assertLibraryAccess(null, user, 'nf')).rejects.toThrow(
      NotFoundException,
    );
  });
});
