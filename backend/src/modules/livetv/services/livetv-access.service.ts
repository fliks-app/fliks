import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LiveTvGroupAccess } from '../entities/livetv-group-access.entity';
import { SettingsService } from '../../settings/settings.service';
import type { User } from '../../users/entities/user.entity';

/** Groups a provider ships that must never be visible by default. */
const ADULT_GROUP_PATTERN = /\b(xxx|adult|porn|erotic|18\+|hot)\b/i;

const RESTRICTED_GROUPS_KEY = 'livetv_restricted_groups';

/** Either of these means the account administers Live TV itself. */
const ADMIN_PERMISSIONS = ['manage:all', 'settings.access'];

/**
 * A restricted group is invisible to everyone who was not granted it. Hiding a
 * channel is the viewer's own preference and they can undo it; this is the
 * control an administrator sets, and the two must not be confused.
 */
@Injectable()
export class LiveTvAccessService {
  constructor(
    @InjectRepository(LiveTvGroupAccess)
    private readonly accessRepo: Repository<LiveTvGroupAccess>,
    private readonly settings: SettingsService,
  ) {}

  async restrictedGroups(): Promise<string[]> {
    const raw = await this.settings.get(RESTRICTED_GROUPS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
    } catch {
      return [];
    }
  }

  async setRestrictedGroups(groups: string[]): Promise<string[]> {
    const unique = [...new Set(groups.map((g) => g.trim()).filter(Boolean))].sort();
    await this.settings.set(RESTRICTED_GROUPS_KEY, JSON.stringify(unique));
    return unique;
  }

  /** Called after a sync: a newly seen adult group starts restricted, because
   *  the alternative is that it is visible to every account until someone notices. */
  async restrictAdultGroups(groupNames: readonly string[]): Promise<string[]> {
    const current = await this.restrictedGroups();
    const additions = groupNames.filter(
      (name) => ADULT_GROUP_PATTERN.test(name) && !current.includes(name),
    );
    if (!additions.length) return current;
    return this.setRestrictedGroups([...current, ...additions]);
  }

  grantsFor(userId: number): Promise<LiveTvGroupAccess[]> {
    return this.accessRepo.find({ where: { user: { id: userId } } });
  }

  async setGrants(userId: number, groupNames: string[]): Promise<string[]> {
    const unique = [...new Set(groupNames.map((g) => g.trim()).filter(Boolean))];
    await this.accessRepo.delete({ user: { id: userId } });
    if (unique.length) {
      await this.accessRepo.save(
        unique.map((groupName) =>
          this.accessRepo.create({ user: { id: userId } as User, groupName }),
        ),
      );
    }
    return unique;
  }

  /**
   * The groups this user must not see: every restricted group they were not
   * granted. An empty result means no filtering is needed at all, which is the
   * common case and costs one settings read.
   */
  async deniedGroups(user: User): Promise<string[]> {
    const restricted = await this.restrictedGroups();
    if (!restricted.length) return [];
    // Whoever configures the lineup is never filtered out of it. The seeded
    // Admin role carries `settings.access` rather than `manage:all`.
    if (ADMIN_PERMISSIONS.some((p) => user.permissions.includes(p))) return [];
    const granted = new Set((await this.grantsFor(user.id)).map((g) => g.groupName));
    return restricted.filter((group) => !granted.has(group));
  }
}
