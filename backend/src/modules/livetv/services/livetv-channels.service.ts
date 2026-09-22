import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { LiveTvUserChannelPref } from '../entities/livetv-user-channel-pref.entity';
import { LiveTvAccessService } from './livetv-access.service';
import { User } from '../../users/entities/user.entity';
import { BulkUpdateChannelsDto } from '../dto/bulk-update-channels.dto';
import { UpdateLiveTvChannelDto } from '../dto/update-livetv-channel.dto';
import { SetChannelPrefsDto } from '../dto/set-channel-prefs.dto';

export interface LiveTvChannelListItem {
  id: number;
  name: string;
  number: number | null;
  logoPath: string | null;
  groupName: string | null;
  guideChannelId: string | null;
  favorite: boolean;
}

export interface LiveTvGroupCount {
  name: string;
  count: number;
}

export interface LiveTvAdminChannelList {
  items: LiveTvChannel[];
  total: number;
  groups: LiveTvGroupCount[];
}

interface ChannelSelection {
  channelIds?: number[];
  group?: string;
  sourceId?: number;
  namePattern?: string;
}

@Injectable()
export class LiveTvChannelsService {
  constructor(
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    @InjectRepository(LiveTvChannelStream)
    private readonly streamRepo: Repository<LiveTvChannelStream>,
    @InjectRepository(LiveTvUserChannelPref)
    private readonly prefRepo: Repository<LiveTvUserChannelPref>,
    private readonly dataSource: DataSource,
    private readonly access: LiveTvAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // User-facing list
  // ---------------------------------------------------------------------------

  async listForUser(
    user: User,
    filters: { group?: string; favoritesOnly?: boolean; query?: string },
  ): Promise<LiveTvChannelListItem[]> {
    return this.runChannelQuery(await this.userChannelsQuery(user, filters));
  }

  /** Same restrictions as the list; drives whether the client shows a Live TV entry at all. */
  async countForUser(user: User): Promise<number> {
    return (await this.userChannelsQuery(user, {})).getCount();
  }

  /**
   * One page of the same list, counted and sliced by the database. The guide
   * endpoints are polled, and a provider lineup runs to thousands of channels:
   * loading all of them to return fifty is the whole cost of the request.
   */
  async listPageForUser(
    user: User,
    filters: { group?: string; favoritesOnly?: boolean; query?: string },
    page: number,
    pageSize: number,
  ): Promise<{ items: LiveTvChannelListItem[]; total: number }> {
    const qb = await this.userChannelsQuery(user, filters);
    const total = await qb.getCount();
    qb.offset((page - 1) * pageSize).limit(pageSize);
    return { items: await this.runChannelQuery(qb), total };
  }

  /** Same visibility rule as the list: authorizes a single program lookup by
   *  the guide channel id it airs on, without duplicating the group filter. */
  async isGuideChannelVisibleToUser(user: User, guideChannelId: string): Promise<boolean> {
    const qb = await this.userChannelsQuery(user, {});
    qb.andWhere('channel."guideChannelId" = :guideChannelId', { guideChannelId });
    return (await qb.getCount()) > 0;
  }

  /** Same visibility rule as the list, as a correlated EXISTS against
   *  `livetv_channels`: scopes another query's guide-channel column without
   *  materializing the authorized set or growing its bound-parameter count
   *  with the catalog size (a 15k-channel lineup would otherwise mean a
   *  15k-placeholder IN list, over Postgres's 65535-parameter cap). */
  async scopeToAuthorizedGuideChannels(
    qb: SelectQueryBuilder<ObjectLiteral>,
    user: User,
    guideChannelIdColumn: string,
  ): Promise<void> {
    const denied = await this.access.deniedGroups(user);
    qb.andWhere(
      `EXISTS (
        SELECT 1 FROM livetv_channels c
        LEFT JOIN livetv_user_channel_prefs pref
          ON pref."channelId" = c.id AND pref."userId" = :guideAuthUserId
        WHERE c."guideChannelId" = ${guideChannelIdColumn}
          AND c.enabled = true
          AND (pref.hidden IS NULL OR pref.hidden = false)
          ${denied.length ? 'AND (c."groupName" IS NULL OR c."groupName" NOT IN (:...guideAuthDenied))' : ''}
      )`,
      { guideAuthUserId: user.id, ...(denied.length ? { guideAuthDenied: denied } : {}) },
    );
  }

  private async runChannelQuery(
    qb: SelectQueryBuilder<LiveTvChannel>,
  ): Promise<LiveTvChannelListItem[]> {
    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((channel, i) => ({
      id: channel.id,
      name: channel.name,
      number: channel.number,
      logoPath: channel.logoPath,
      groupName: channel.groupName,
      guideChannelId: channel.guideChannelId,
      favorite: raw[i]?.pref_favorite === true,
    }));
  }

  private async userChannelsQuery(
    user: User,
    filters: { group?: string; favoritesOnly?: boolean; query?: string },
  ): Promise<SelectQueryBuilder<LiveTvChannel>> {
    const qb = this.channelRepo
      .createQueryBuilder('channel')
      .leftJoin(
        LiveTvUserChannelPref,
        'pref',
        'pref."channelId" = channel.id AND pref."userId" = :userId',
        { userId: user.id },
      )
      .addSelect('pref.favorite', 'pref_favorite')
      .where('channel.enabled = true')
      .andWhere('(pref.hidden IS NULL OR pref.hidden = false)');

    // A restricted group is absent from the list entirely, not merely hidden:
    // hiding is the viewer's own preference and they can undo it.
    const denied = await this.access.deniedGroups(user);
    if (denied.length) {
      qb.andWhere('(channel."groupName" IS NULL OR channel."groupName" NOT IN (:...denied))', {
        denied,
      });
    }

    if (filters.group) qb.andWhere('channel."groupName" = :group', { group: filters.group });
    if (filters.favoritesOnly) qb.andWhere('pref.favorite = true');
    if (filters.query) {
      qb.andWhere('channel.name ILIKE :q', { q: `%${filters.query}%` });
    }

    qb.orderBy('COALESCE(pref.favorite, false)', 'DESC')
      .addOrderBy('channel.number', 'ASC', 'NULLS LAST')
      .addOrderBy('channel."sortIndex"', 'ASC')
      .addOrderBy('channel.name', 'ASC');

    return qb;
  }

  // ---------------------------------------------------------------------------
  // Admin list
  // ---------------------------------------------------------------------------

  async listForAdmin(filters: {
    sourceId?: number;
    group?: string;
    enabled?: boolean;
    query?: string;
    page?: number;
    pageSize?: number;
  }): Promise<LiveTvAdminChannelList> {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 50;

    const filtered = this.channelRepo.createQueryBuilder('channel');
    this.applyAdminFilters(filtered, filters);

    const total = await filtered.clone().getCount();
    const idRows = await filtered
      .clone()
      .select('channel.id', 'id')
      .orderBy('channel.name', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<{ id: number }>();
    const ids = idRows.map((r) => r.id);

    // Two-step pagination: paginating directly over a to-many join (streams)
    // would slice mid-channel and corrupt both the page size and the count.
    const data = ids.length
      ? await this.channelRepo
          .createQueryBuilder('channel')
          .leftJoinAndSelect('channel.streams', 'stream')
          .leftJoinAndSelect('stream.source', 'source')
          .where('channel.id IN (:...ids)', { ids })
          .getMany()
      : [];
    const byId = new Map(data.map((c) => [c.id, c]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((c): c is LiveTvChannel => c != null);

    return { items: ordered, total, groups: await this.groupCounts(filters.sourceId) };
  }

  private applyAdminFilters(
    qb: SelectQueryBuilder<LiveTvChannel>,
    filters: { sourceId?: number; group?: string; enabled?: boolean; query?: string },
  ): void {
    if (filters.group) qb.andWhere('channel."groupName" = :group', { group: filters.group });
    if (filters.enabled !== undefined) {
      qb.andWhere('channel.enabled = :enabled', { enabled: filters.enabled });
    }
    if (filters.query) qb.andWhere('channel.name ILIKE :q', { q: `%${filters.query}%` });
    if (filters.sourceId != null) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = channel.id AND s2."sourceId" = :sourceId)',
        { sourceId: filters.sourceId },
      );
    }
  }

  /** Scoped only by `sourceId` (when given): a stable facet list, not re-narrowed
   *  by the group/enabled/query filters that pick the current page. */
  private async groupCounts(sourceId?: number): Promise<LiveTvGroupCount[]> {
    const qb = this.channelRepo
      .createQueryBuilder('channel')
      .select('channel."groupName"', 'name')
      .addSelect('COUNT(*)', 'count')
      .where('channel."groupName" IS NOT NULL')
      .groupBy('channel."groupName"');
    if (sourceId != null) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = channel.id AND s2."sourceId" = :sourceId)',
        { sourceId },
      );
    }
    const rows = await qb.getRawMany<{ name: string; count: string }>();
    return rows
      .map((r) => ({ name: r.name, count: Number(r.count) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------------
  // Bulk edit
  // ---------------------------------------------------------------------------

  async bulkUpdate(dto: BulkUpdateChannelsDto): Promise<{ affected: number }> {
    const selectQb = this.channelRepo
      .createQueryBuilder('channel')
      .select(['channel.id', 'channel.name']);
    this.applySelection(selectQb, dto.selection);
    const matched = await selectQb.getMany();
    if (!matched.length) return { affected: 0 };
    const ids = matched.map((c) => c.id);

    if (dto.enabled !== undefined) {
      await this.channelRepo
        .createQueryBuilder()
        .update(LiveTvChannel)
        .set({ enabled: dto.enabled })
        .whereInIds(ids)
        .execute();
    }
    if (dto.groupName !== undefined) {
      await this.channelRepo
        .createQueryBuilder()
        .update(LiveTvChannel)
        .set({ groupName: dto.groupName })
        .whereInIds(ids)
        .execute();
    }
    if (dto.startNumber !== undefined) {
      const orderedIds = dto.selection.channelIds?.length
        ? dto.selection.channelIds.filter((id) => ids.includes(id))
        : [...matched].sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.id);
      await this.renumber(orderedIds, dto.startNumber);
    }

    return { affected: ids.length };
  }

  private applySelection(qb: SelectQueryBuilder<LiveTvChannel>, sel: ChannelSelection): void {
    if (sel.channelIds?.length) {
      qb.andWhere('channel.id IN (:...ids)', { ids: sel.channelIds });
    }
    if (sel.group) qb.andWhere('channel."groupName" = :group', { group: sel.group });
    if (sel.sourceId != null) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = channel.id AND s2."sourceId" = :sourceId)',
        { sourceId: sel.sourceId },
      );
    }
    if (sel.namePattern) qb.andWhere('channel.name ILIKE :pattern', { pattern: `%${sel.namePattern}%` });
  }

  /** One UPDATE ... FROM (VALUES ...) statement, never a per-row round trip. */
  private async renumber(orderedIds: number[], startNumber: number): Promise<void> {
    if (!orderedIds.length) return;
    const params: number[] = [];
    const values = orderedIds
      .map((id, i) => {
        params.push(id, startNumber + i);
        return `($${params.length - 1}, $${params.length})`;
      })
      .join(',');
    await this.dataSource.query(
      `UPDATE livetv_channels AS c SET number = v.n FROM (VALUES ${values}) AS v(id, n) WHERE c.id = v.id`,
      params,
    );
  }

  /** Loaded with its streams (and their source) for {@link LiveTvSessionService.open}. */
  /** `user` is required: a channel the caller may not see must not be playable
   *  by guessing its id. */
  async findPlayable(id: number, user: User): Promise<LiveTvChannel> {
    const channel = await this.channelRepo.findOne({
      where: { id, enabled: true },
      relations: ['streams', 'streams.source'],
    });
    if (!channel) throw new NotFoundException(`Live TV channel #${id} not found`);
    const denied = await this.access.deniedGroups(user);
    if (channel.groupName && denied.includes(channel.groupName)) {
      throw new NotFoundException(`Live TV channel #${id} not found`);
    }
    return channel;
  }

  // ---------------------------------------------------------------------------
  // Merge / single update / prefs / guide assignment
  // ---------------------------------------------------------------------------

  async merge(targetChannelId: number, sourceChannelIds: number[]): Promise<void> {
    const ids = sourceChannelIds.filter((id) => id !== targetChannelId);
    if (!ids.length) return;

    await this.dataSource.transaction(async (manager) => {
      const channelRepo = manager.getRepository(LiveTvChannel);
      const streamRepo = manager.getRepository(LiveTvChannelStream);

      const target = await channelRepo.findOne({
        where: { id: targetChannelId },
        relations: ['streams'],
      });
      if (!target) throw new NotFoundException(`Live TV channel #${targetChannelId} not found`);

      const streams = await streamRepo.find({
        where: { channel: { id: In(ids) } },
        order: { priority: 'ASC' },
      });
      let priority = target.streams.length;
      for (const stream of streams) {
        stream.channel = target;
        stream.priority = priority++;
      }
      if (streams.length) await streamRepo.save(streams, { chunk: 500 });

      await channelRepo.delete(ids);
    });
  }

  async updateOne(id: number, dto: UpdateLiveTvChannelDto): Promise<LiveTvChannel> {
    const channel = await this.channelRepo.findOne({ where: { id } });
    if (!channel) throw new NotFoundException(`Live TV channel #${id} not found`);

    if (dto.name !== undefined) channel.name = dto.name;
    if (dto.number !== undefined) channel.number = dto.number;
    if (dto.groupName !== undefined) channel.groupName = dto.groupName;
    if (dto.enabled !== undefined) channel.enabled = dto.enabled;
    if (dto.guideShiftMinutes !== undefined) channel.guideShiftMinutes = dto.guideShiftMinutes;
    if (dto.guideChannelId !== undefined) {
      channel.guideChannelId = dto.guideChannelId;
      channel.guideMatchKind = 'manual';
    }
    return this.channelRepo.save(channel);
  }

  async setGuideChannel(channelId: number, guideChannelId: string): Promise<void> {
    const res = await this.channelRepo.update(channelId, {
      guideChannelId,
      guideMatchKind: 'manual',
    });
    if (!res.affected) throw new NotFoundException(`Live TV channel #${channelId} not found`);
  }

  async setPrefs(user: User, channelId: number, dto: SetChannelPrefsDto): Promise<void> {
    let pref = await this.prefRepo.findOne({
      where: { user: { id: user.id }, channel: { id: channelId } },
    });
    if (!pref) {
      pref = this.prefRepo.create({
        user: { id: user.id } as User,
        channel: { id: channelId } as LiveTvChannel,
      });
    }
    if (dto.favorite !== undefined) pref.favorite = dto.favorite;
    if (dto.hidden !== undefined) pref.hidden = dto.hidden;
    await this.prefRepo.save(pref);
  }
}
