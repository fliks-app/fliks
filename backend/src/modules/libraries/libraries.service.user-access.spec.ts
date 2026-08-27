import { LibrariesService } from './libraries.service';
import { LibraryUserAccess } from './entities/library-user-access.entity';

/**
 * Access is a row per (library, user) and a non-admin sees exactly the
 * libraries they hold a row for. Granting access to a new library therefore
 * must not touch the rows that carry the other libraries: widening the delete
 * to the users being granted would silently take every library they had.
 */
describe('LibrariesService.create — user access', () => {
  function harness() {
    const deletes: unknown[] = [];
    const saved: unknown[] = [];

    const m = {
      create: (_entity: unknown, row: Record<string, unknown>) => row,
      save: async (row: unknown) => {
        if (Array.isArray(row)) saved.push(...row);
        else if ((row as { name?: string }).name) return { ...(row as object), id: 42 };
        return row;
      },
      delete: async (entity: unknown, criteria: unknown) => {
        deletes.push({ entity, criteria });
        return { affected: 0 };
      },
      update: async () => ({ affected: 1 }),
      findOne: async () => null,
      count: async () => 0,
    };

    const service = new LibrariesService(
      { findOne: async () => ({ id: 42, name: 'Docs', path: null }) } as never,
      { find: async () => [] } as never,
      {} as never,
      { transaction: async (fn: (mm: unknown) => unknown) => fn(m) } as never,
      {} as never,
    );
    return { service, deletes, saved };
  }

  it('VERDICT: clears access for the new library only, never for the users granted it', async () => {
    const { service, deletes, saved } = harness();

    await service.create({ name: 'Docs', userIds: [7, 9] } as never);

    expect(deletes).toEqual([
      { entity: LibraryUserAccess, criteria: { library: { id: 42 } } },
    ]);
    expect(saved).toEqual([
      { library: { id: 42 }, user: { id: 7 } },
      { library: { id: 42 }, user: { id: 9 } },
    ]);
  });

  it('touches no access row at all when the library is created with nobody', async () => {
    const { service, deletes, saved } = harness();

    await service.create({ name: 'Docs', userIds: [] } as never);

    expect(deletes).toEqual([]);
    expect(saved).toEqual([]);
  });
});
