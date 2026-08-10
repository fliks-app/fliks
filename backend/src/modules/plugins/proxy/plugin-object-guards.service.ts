import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LibrariesService } from '../../libraries/libraries.service';
import { MediaService } from '../../media/media.service';
import type { User } from '../../users/entities/user.entity';

/** The only two object guards a manifest may declare — never a free-form expression. */
export type ObjectGuardName = 'mediaAccessible' | 'libraryAccessible';

const OBJECT_GUARD_NAMES: ReadonlySet<string> = new Set<ObjectGuardName>(['mediaAccessible', 'libraryAccessible']);

export interface ParsedObjectGuard {
  guard: ObjectGuardName;
  paramName: string;
}

/** `"<guardName>:<paramName>"`, the guard name from the closed set above. Anything else is `null`. */
export function parseObjectGuard(spec: string): ParsedObjectGuard | null {
  const parts = spec.split(':');
  if (parts.length !== 2) return null;
  const [guard, paramName] = parts;
  if (!OBJECT_GUARD_NAMES.has(guard) || paramName === '') return null;
  return { guard: guard as ObjectGuardName, paramName };
}

/** Strict positive base-10 integer only — no `parseInt`/`Number()` coercion of signs, decimals,
 *  leading zeros or whitespace, and nothing past `Number.MAX_SAFE_INTEGER`. */
export function parsePositiveInt(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

@Injectable()
export class PluginObjectGuardsService {
  constructor(
    private readonly libraries: LibrariesService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Resolved lazily, at call time: a static import/DI edge here would close a
   *  `Plugins -> Media -> Indexers -> Plugins` module cycle. */
  private mediaService(): MediaService {
    return this.moduleRef.get(MediaService, { strict: false });
  }

  /** The captured route param is attacker-controlled text; a value that isn't a
   *  strict positive integer never reaches `LibrariesService`/`MediaService`. */
  async check(guard: ObjectGuardName, rawValue: string, user: User): Promise<boolean> {
    const id = parsePositiveInt(rawValue);
    if (id === null) return false;

    const accessibleLibraryIds = await this.libraries.getAccessibleLibraryIds(user);
    if (guard === 'libraryAccessible') return accessibleLibraryIds.includes(id);

    try {
      await this.mediaService().assertAccessible(id, accessibleLibraryIds);
      return true;
    } catch {
      return false;
    }
  }
}
