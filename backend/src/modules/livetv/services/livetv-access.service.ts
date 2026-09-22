import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LiveTvGroupAccess } from '../entities/livetv-group-access.entity';
import { SettingsService } from '../../settings/settings.service';
import { User } from '../../users/entities/user.entity';

/** Groups a provider ships that must never be visible by default. */
const ADULT_GROUP_PATTERN = /\b(xxx|adult|porn|erotic|18\+|hot)\b/i;

const RESTRICTED_GROUPS_KEY = 'livetv_restricted_groups';
/** Auto-matched groups an admin explicitly unrestricted; skipped by `restrictAdultGroups`. */
const EXEMPT_GROUPS_KEY = 'livetv_restricted_groups_exempt';

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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly settings: SettingsService,
  ) {}

  private async readGroupSet(key: string): Promise<string[]> {
    const raw = await this.settings.get(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((g): g is string => typeof g === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private async writeGroupSet(
    key: string,
    groups: string[],
  ): Promise<string[]> {
    const unique = [
      ...new Set(groups.map((g) => g.trim()).filter(Boolean)),
    ].sort();
    await this.settings.set(key, JSON.stringify(unique));
    return unique;
  }

  restrictedGroups(): Promise<string[]> {
    return this.readGroupSet(RESTRICTED_GROUPS_KEY);
  }

  /** Groups an admin unrestricted that would otherwise be re-added by the next sync. */
  exemptGroups(): Promise<string[]> {
    return this.readGroupSet(EXEMPT_GROUPS_KEY);
  }

  /** Restricted groups plus whether each still matches the automatic adult-content
   *  pattern, so the client can show the hint without duplicating the pattern. */
  async restrictedGroupsView(): Promise<
    { name: string; automatic: boolean }[]
  > {
    const groups = await this.restrictedGroups();
    return groups.map((name) => ({
      name,
      automatic: ADULT_GROUP_PATTERN.test(name),
    }));
  }

  async setRestrictedGroups(groups: string[]): Promise<string[]> {
    const previous = await this.restrictedGroups();
    const unique = await this.writeGroupSet(RESTRICTED_GROUPS_KEY, groups);

    // A group leaving the restricted set must not leave its grants behind: they would
    // silently resurrect for whoever held them if the group is restricted again later.
    // `restrictAdultGroups` only ever grows the set, so `dropped` is always empty there.
    const dropped = previous.filter((g) => !unique.includes(g));
    if (dropped.length) {
      await this.accessRepo.delete({ groupName: In(dropped) });
    }

    // An auto-matched group leaving the set is an explicit exemption (otherwise the
    // next sync restricts it again); one re-added here retires that exemption.
    const removed = dropped.filter((g) => ADULT_GROUP_PATTERN.test(g));
    const readded = unique.filter((g) => ADULT_GROUP_PATTERN.test(g));
    if (removed.length || readded.length) {
      const exempt = new Set(await this.exemptGroups());
      removed.forEach((g) => exempt.add(g));
      readded.forEach((g) => exempt.delete(g));
      await this.writeGroupSet(EXEMPT_GROUPS_KEY, [...exempt]);
    }

    return unique;
  }

  /** Called after a sync: a newly seen adult group starts restricted, because the
   *  alternative is that it is visible to every account until someone notices. A
   *  group an admin exempted (unchecked) is left alone across syncs. */
  async restrictAdultGroups(groupNames: readonly string[]): Promise<string[]> {
    const current = await this.restrictedGroups();
    const exempt = await this.exemptGroups();
    const additions = groupNames.filter(
      (name) =>
        ADULT_GROUP_PATTERN.test(name) &&
        !current.includes(name) &&
        !exempt.includes(name),
    );
    if (!additions.length) return current;
    return this.setRestrictedGroups([...current, ...additions]);
  }

  grantsFor(userId: number): Promise<LiveTvGroupAccess[]> {
    return this.accessRepo.find({ where: { user: { id: userId } } });
  }

  /** Every user with the restricted groups they were individually granted,
   *  for the access tab's overview table. */
  async listUserAccess(): Promise<
    { id: number; username: string; groups: string[] }[]
  > {
    const users = await this.userRepo.find({
      select: ['id', 'username'],
      order: { username: 'ASC' },
    });
    if (!users.length) return [];
    const rows = await this.accessRepo
      .createQueryBuilder('a')
      .select(['a."userId" AS "userId"', 'a."groupName" AS "groupName"'])
      .where('a."userId" IN (:...ids)', { ids: users.map((u) => u.id) })
      .getRawMany<{ userId: number; groupName: string }>();
    const byUser = new Map<number, string[]>();
    for (const r of rows) {
      const arr = byUser.get(r.userId) ?? [];
      arr.push(r.groupName);
      byUser.set(r.userId, arr);
    }
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      groups: byUser.get(u.id) ?? [],
    }));
  }

  async setGrants(userId: number, groupNames: string[]): Promise<string[]> {
    const unique = [
      ...new Set(groupNames.map((g) => g.trim()).filter(Boolean)),
    ];
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
    const granted = new Set(
      (await this.grantsFor(user.id)).map((g) => g.groupName),
    );
    return restricted.filter((group) => !granted.has(group));
  }
}
