import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LiveTvGroupAccess } from '../entities/livetv-group-access.entity';
import {
  OWN_MODULE_ORIGIN,
  SettingsService,
} from '../../settings/settings.service';
import { User } from '../../users/entities/user.entity';

/** Groups a provider ships that must never be visible by default, across the app's
 *  languages (en/fr/es/de/it/pt). Heuristic, not exhaustive; excludes "Adult Swim". */
const ADULT_GROUP_PATTERN =
  /\b(?:xxx|sex[eo]?|porn\w*|erot(?:ic|iqu|ik)\w*|x[- ]?rated|adult(?!\s*swim\b)\w*)\b|(?<![a-z0-9])(?:\+18|18\+)(?![a-z0-9])/i;

const RESTRICTED_GROUPS_KEY = 'livetv_restricted_groups';
/** Auto-matched groups an admin explicitly unrestricted; skipped by `restrictAdultGroups`. */
const EXEMPT_GROUPS_KEY = 'livetv_restricted_groups_exempt';
/** JSON map of group name to the ISO date it was first missing from a full,
 *  successful sync; cleared the moment the group is seen again. */
const VANISHED_GROUPS_KEY = 'livetv_restricted_groups_vanished';
const MS_PER_DAY = 86_400_000;

/** Either of these means the account administers Live TV itself. */
const ADMIN_PERMISSIONS = ['manage:all', 'settings.access'];

/**
 * A restricted group is invisible to everyone who was not granted it. Hiding a
 * channel is the viewer's own preference and they can undo it; this is the
 * control an administrator sets, and the two must not be confused.
 */
@Injectable()
export class LiveTvAccessService {
  private readonly log = new Logger(LiveTvAccessService.name);

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

  private normalizeGroupSet(groups: string[]): string[] {
    return [...new Set(groups.map((g) => g.trim()).filter(Boolean))].sort();
  }

  private async writeGroupSet(
    key: string,
    groups: string[],
  ): Promise<string[]> {
    const unique = this.normalizeGroupSet(groups);
    await this.settings.set(key, JSON.stringify(unique), OWN_MODULE_ORIGIN);
    return unique;
  }

  restrictedGroups(): Promise<string[]> {
    return this.readGroupSet(RESTRICTED_GROUPS_KEY);
  }

  /** Groups an admin unrestricted that would otherwise be re-added by the next sync. */
  exemptGroups(): Promise<string[]> {
    return this.readGroupSet(EXEMPT_GROUPS_KEY);
  }

  private async readVanishedMap(): Promise<Record<string, string>> {
    const raw = await this.settings.get(VANISHED_GROUPS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return {};
      const out: Record<string, string> = {};
      for (const [name, since] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof since === 'string') out[name] = since;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeVanishedMap(map: Record<string, string>): Promise<void> {
    await this.settings.set(
      VANISHED_GROUPS_KEY,
      JSON.stringify(map),
      OWN_MODULE_ORIGIN,
    );
  }

  private lock: Promise<void> = Promise.resolve();

  /** Serializes restricted/exempt/vanished read-modify-write sequences so a sync pass and
   *  an admin edit can't interleave on a stale read.
   *  ponytail: in-process mutex; move to pg_advisory_xact_lock if this ever runs multi-instance. */
  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async graceDays(): Promise<number> {
    const raw = await this.settings.get('livetv_stale_stream_days');
    const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? n : 7;
  }

  /** Restricted groups plus whether each still matches the automatic adult-content
   *  pattern, and since when it has been missing from a live lineup (if at all),
   *  so the client can show the grace-period countdown without a second call. */
  async restrictedGroupsView(): Promise<
    {
      name: string;
      automatic: boolean;
      vanishedSince: string | null;
      cleanupAt: string | null;
    }[]
  > {
    const [groups, vanished, graceDays] = await Promise.all([
      this.restrictedGroups(),
      this.readVanishedMap(),
      this.graceDays(),
    ]);
    return groups.map((name) => {
      const vanishedSince = vanished[name] ?? null;
      return {
        name,
        automatic: ADULT_GROUP_PATTERN.test(name),
        vanishedSince,
        cleanupAt: vanishedSince
          ? new Date(
              new Date(vanishedSince).getTime() + graceDays * MS_PER_DAY,
            ).toISOString()
          : null,
      };
    });
  }

  async setRestrictedGroups(groups: string[]): Promise<string[]> {
    return this.withWriteLock(() => this.setRestrictedGroupsLocked(groups));
  }

  private async setRestrictedGroupsLocked(groups: string[]): Promise<string[]> {
    const previous = await this.restrictedGroups();
    const unique = this.normalizeGroupSet(groups);

    // A group leaving the restricted set must not leave its grants behind: they would
    // silently resurrect for whoever held them if the group is restricted again later.
    // `restrictAdultGroups` only ever grows the set, so `dropped` is always empty there.
    // Grants are dropped before the setting is written: a failure here leaves the group
    // still restricted (safe) instead of open with its grants dangling (unsafe).
    const dropped = previous.filter((g) => !unique.includes(g));
    if (dropped.length) {
      await this.accessRepo.delete({ groupName: In(dropped) });
    }
    await this.writeGroupSet(RESTRICTED_GROUPS_KEY, unique);

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
    return this.withWriteLock(async () => {
      const current = await this.restrictedGroups();
      const exempt = await this.exemptGroups();
      const additions = groupNames.filter(
        (name) =>
          ADULT_GROUP_PATTERN.test(name) &&
          !current.includes(name) &&
          !exempt.includes(name),
      );
      if (!additions.length) return current;
      return this.setRestrictedGroupsLocked([...current, ...additions]);
    });
  }

  /** Trusts that `liveGroupNames` is complete — verifying that is the caller's job.
   *  A restricted or exempted group missing from it is timestamped, cleared the
   *  moment it reappears; only past `livetv_stale_stream_days` does it actually
   *  lose its grants and its list entries. */
  async expireVanishedGroups(
    liveGroupNames: readonly string[],
  ): Promise<string[]> {
    return this.withWriteLock(() =>
      this.expireVanishedGroupsLocked(liveGroupNames),
    );
  }

  private async expireVanishedGroupsLocked(
    liveGroupNames: readonly string[],
  ): Promise<string[]> {
    const live = new Set(liveGroupNames);
    const candidates = new Set([
      ...(await this.restrictedGroups()),
      ...(await this.exemptGroups()),
    ]);

    const vanished = await this.readVanishedMap();
    let changed = false;
    const now = new Date().toISOString();
    for (const name of candidates) {
      if (live.has(name)) {
        if (name in vanished) {
          delete vanished[name];
          changed = true;
        }
        continue;
      }
      if (!(name in vanished)) {
        vanished[name] = now;
        changed = true;
      }
    }
    // Bookkeeping for a group nobody tracks anymore (already unrestricted and unexempted).
    for (const name of Object.keys(vanished)) {
      if (!candidates.has(name)) {
        delete vanished[name];
        changed = true;
      }
    }

    const cutoff = Date.now() - (await this.graceDays()) * MS_PER_DAY;
    const expired = Object.entries(vanished)
      .filter(([, since]) => new Date(since).getTime() <= cutoff)
      .map(([name]) => name);

    if (expired.length) {
      await this.accessRepo.delete({ groupName: In(expired) });
      await this.writeGroupSet(
        RESTRICTED_GROUPS_KEY,
        (await this.restrictedGroups()).filter((g) => !expired.includes(g)),
      );
      await this.writeGroupSet(
        EXEMPT_GROUPS_KEY,
        (await this.exemptGroups()).filter((g) => !expired.includes(g)),
      );
      expired.forEach((name) => delete vanished[name]);
      changed = true;
      this.log.warn(
        `Dropped Live TV access for vanished channel group(s): ${expired.join(', ')}`,
      );
    }

    if (changed) await this.writeVanishedMap(vanished);
    return expired;
  }

  grantsFor(userId: number): Promise<LiveTvGroupAccess[]> {
    return this.accessRepo.find({ where: { user: { id: userId } } });
  }

  /** Every user with the restricted groups they were individually granted,
   *  for the access tab's overview table. `hasFullAccess` mirrors the same
   *  short-circuit {@link deniedGroups} uses, so the table can show why an
   *  admin account's grants don't matter instead of rendering it empty. */
  async listUserAccess(): Promise<
    { id: number; username: string; groups: string[]; hasFullAccess: boolean }[]
  > {
    const users = await this.userRepo.find({ order: { username: 'ASC' } });
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
      hasFullAccess: ADMIN_PERMISSIONS.some((p) => u.permissions.includes(p)),
    }));
  }

  /** A grant only ever applies to a currently-restricted group: granting anything else
   *  would sit dormant and silently activate the day someone restricts that name (the
   *  resurrection this closes from the other end). `ignored` names what was dropped. */
  async setGrants(
    userId: number,
    groupNames: string[],
  ): Promise<{ groups: string[]; ignored: string[] }> {
    const requested = [
      ...new Set(groupNames.map((g) => g.trim()).filter(Boolean)),
    ];
    const restricted = new Set(await this.restrictedGroups());
    const groups = requested.filter((g) => restricted.has(g));
    const ignored = requested.filter((g) => !restricted.has(g));

    await this.accessRepo.delete({ user: { id: userId } });
    if (groups.length) {
      await this.accessRepo.save(
        groups.map((groupName) =>
          this.accessRepo.create({ user: { id: userId } as User, groupName }),
        ),
      );
    }
    return { groups, ignored };
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
