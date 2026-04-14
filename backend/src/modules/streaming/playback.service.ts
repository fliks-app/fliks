import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { PlaybackState } from './entities/playback-state.entity';

export interface WatchHistoryItem {
  id: number;
  mediaId: number;
  mediaFileId: number | null;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  completed: boolean;
  lastPlayedAt: Date;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  episodeLabel: string | null;
}

export interface ContinueWatchingItem {
  id: number;
  mediaId: number;
  mediaFileId: number | null;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  lastPlayedAt: Date;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  episodeLabel: string | null;
}

export interface MediaResumeInfo {
  mediaFileId: number | null;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

@Injectable()
export class PlaybackService implements OnModuleInit {
  private readonly log = new Logger(PlaybackService.name);

  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
  ) {}

  async onModuleInit() {
    await this.deduplicateAndCreateIndexes();
  }

  /**
   * Deduplicate legacy rows (multiple per mediaId+episodeId) and create partial unique indexes.
   * Safe to run repeatedly — uses IF NOT EXISTS.
   */
  private async deduplicateAndCreateIndexes() {
    try {
      // Delete duplicates: for each (userId, mediaId, episodeId) group, keep only the most recent row
      const deleted = await this.repo.query(`
        DELETE FROM playback_states ps
        USING (
          SELECT "userId", "mediaId", COALESCE("episodeId", 0) AS eid,
                 MAX(id) AS keep_id
          FROM playback_states
          GROUP BY "userId", "mediaId", COALESCE("episodeId", 0)
          HAVING COUNT(*) > 1
        ) dups
        WHERE ps."userId" = dups."userId"
          AND ps."mediaId" = dups."mediaId"
          AND COALESCE(ps."episodeId", 0) = dups.eid
          AND ps.id != dups.keep_id
        RETURNING ps.id
      `);
      if (deleted?.length) {
        this.log.log(
          `Deduplicated ${deleted.length} legacy playback_states rows`,
        );
      }

      // Drop the old unique constraint if it still exists
      await this.repo
        .query(
          `
        ALTER TABLE playback_states
        DROP CONSTRAINT IF EXISTS "UQ_playback_states_userId_mediaFileId"
      `,
        )
        .catch(() => {});
      // TypeORM may name it differently
      await this.repo
        .query(
          `
        DROP INDEX IF EXISTS "UQ_playback_states_userId_mediaFileId"
      `,
        )
        .catch(() => {});

      // Create partial unique indexes
      await this.repo.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_user_movie
        ON playback_states ("userId", "mediaId")
        WHERE "episodeId" IS NULL
      `);
      await this.repo.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_user_episode
        ON playback_states ("userId", "episodeId")
        WHERE "episodeId" IS NOT NULL
      `);
    } catch (err) {
      this.log.warn(`Failed to create playback unique indexes: ${err}`);
    }
  }

  /** Find state by media/episode (the new primary lookup). */
  private findState(
    userId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<PlaybackState | null> {
    return this.repo.findOne({
      where: {
        user: { id: userId },
        media: { id: mediaId },
        episode: episodeId
          ? { id: episodeId }
          : (IsNull() as unknown as { id: number }),
      },
    });
  }

  async getState(
    userId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<PlaybackState | null> {
    return this.findState(userId, mediaId, episodeId);
  }

  async getMediaResumeInfo(
    userId: number,
    mediaId: number,
  ): Promise<MediaResumeInfo | null> {
    const rows: MediaResumeInfo[] = await this.repo.query(
      `SELECT
         ps."mediaFileId", ps."episodeId",
         ps."positionSeconds", ps."durationSeconds",
         s."seasonNumber", e."episodeNumber"
       FROM playback_states ps
       LEFT JOIN episodes e ON e.id = ps."episodeId"
       LEFT JOIN seasons s ON s.id = e."seasonId"
       WHERE ps."userId" = $1
         AND ps."mediaId" = $2
         AND ps.completed = false
         AND ps."positionSeconds" > 10
       ORDER BY ps."lastPlayedAt" DESC
       LIMIT 1`,
      [userId, mediaId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      mediaFileId: r.mediaFileId,
      episodeId: r.episodeId,
      positionSeconds: Number(r.positionSeconds),
      durationSeconds: Number(r.durationSeconds),
      seasonNumber: r.seasonNumber ?? undefined,
      episodeNumber: r.episodeNumber ?? undefined,
    };
  }

  async getWatchedEpisodeIds(
    userId: number,
    mediaId: number,
  ): Promise<number[]> {
    const rows: { episodeId: number }[] = await this.repo.query(
      `SELECT DISTINCT ps."episodeId"
       FROM playback_states ps
       WHERE ps."userId" = $1 AND ps."mediaId" = $2
         AND ps.completed = true AND ps."episodeId" IS NOT NULL`,
      [userId, mediaId],
    );
    return rows.map((r) => r.episodeId);
  }

  async updateState(
    userId: number,
    mediaId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
    },
  ): Promise<PlaybackState> {
    let state = await this.findState(userId, mediaId, body.episodeId);

    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    const completed = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);

    if (state) {
      state.positionSeconds = pos;
      if (dur > 0) state.durationSeconds = dur;
      state.completed = completed;
      state.hiddenFromContinueWatching = false;
      state.lastPlayedAt = new Date();
      state.mediaFileId = body.mediaFileId;
    } else {
      state = this.repo.create({
        userId,
        mediaId,
        mediaFileId: body.mediaFileId,
        episode:
          body.episodeId != null ? ({ id: body.episodeId } as Episode) : null,
        positionSeconds: pos,
        durationSeconds: dur || 0,
        completed,
        lastPlayedAt: new Date(),
      });
    }

    return this.repo.save(state);
  }

  async getContinueWatching(
    userId: number,
    accessibleLibraryIds?: number[] | null,
  ): Promise<ContinueWatchingItem[]> {
    if (
      accessibleLibraryIds !== undefined &&
      accessibleLibraryIds !== null &&
      accessibleLibraryIds.length === 0
    ) {
      return [];
    }
    const libFilter =
      accessibleLibraryIds === undefined || accessibleLibraryIds === null
        ? ''
        : ` AND m."libraryId" = ANY($2)`;
    const params: unknown[] =
      accessibleLibraryIds === undefined || accessibleLibraryIds === null
        ? [userId]
        : [userId, accessibleLibraryIds];
    // 1. Movies: in-progress, one per media (guaranteed unique by new schema)
    const movies: ContinueWatchingItem[] = await this.repo.query(
      `SELECT
              ps.id, ps."mediaId", ps."mediaFileId", ps."episodeId",
              ps."positionSeconds", ps."durationSeconds", ps."lastPlayedAt",
              m.title AS "mediaTitle", m."posterUrl", m."fanartUrl",
              CASE WHEN ps."durationSeconds" > 0
                   THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
                   ELSE 0 END AS "progressPercent"
       FROM playback_states ps
       JOIN media m ON m.id = ps."mediaId"
       WHERE ps."userId" = $1
         AND ps.completed = false
         AND ps."hiddenFromContinueWatching" = false
         AND ps."positionSeconds" > 0
         AND m.type = 'movie'${libFilter}
       ORDER BY ps."lastPlayedAt" DESC`,
      params,
    );
    for (const m of movies) {
      m.mediaType = 'movie';
      m.episodeLabel = null;
      m.progressPercent = Number(m.progressPercent);
    }

    // 2. Series "next up"
    const seriesItems: ContinueWatchingItem[] = await this.repo.query(
      `WITH user_series AS (
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."lastPlayedAt"
        FROM playback_states ps
        JOIN media m ON m.id = ps."mediaId"
        WHERE ps."userId" = $1 AND m.type = 'series'
          AND ps."hiddenFromContinueWatching" = false
        ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
      ),
      last_completed AS (
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."episodeId",
               s."seasonNumber", e."episodeNumber"
        FROM playback_states ps
        JOIN episodes e ON e.id = ps."episodeId"
        JOIN seasons s ON s.id = e."seasonId"
        WHERE ps."userId" = $1 AND ps.completed = true AND ps."episodeId" IS NOT NULL
        ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
      ),
      in_progress AS (
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."episodeId", ps."mediaFileId",
               ps."positionSeconds", ps."durationSeconds"
        FROM playback_states ps
        WHERE ps."userId" = $1
          AND ps.completed = false AND ps."positionSeconds" > 0 AND ps."episodeId" IS NOT NULL
        ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
      ),
      next_ep AS (
        SELECT lc."mediaId",
               (SELECT e.id FROM episodes e
                JOIN seasons s ON s.id = e."seasonId"
                WHERE s."mediaId" = lc."mediaId" AND s."seasonNumber" > 0
                  AND (s."seasonNumber" > lc."seasonNumber"
                       OR (s."seasonNumber" = lc."seasonNumber" AND e."episodeNumber" > lc."episodeNumber"))
                ORDER BY s."seasonNumber", e."episodeNumber" LIMIT 1
               ) AS "episodeId"
        FROM last_completed lc
        WHERE lc."mediaId" NOT IN (SELECT "mediaId" FROM in_progress)
      ),
      combined AS (
        SELECT ip."mediaId", ip."episodeId", ip."mediaFileId", ip."positionSeconds", ip."durationSeconds"
        FROM in_progress ip
        UNION ALL
        SELECT ne."mediaId", ne."episodeId", NULL::int AS "mediaFileId", 0.0 AS "positionSeconds", 0.0 AS "durationSeconds"
        FROM next_ep ne WHERE ne."episodeId" IS NOT NULL
      )
      SELECT
        COALESCE(ps_next.id, 0) AS id,
        c."mediaId",
        COALESCE(c."mediaFileId", mf.id) AS "mediaFileId",
        c."episodeId",
        COALESCE(ps_next."positionSeconds", c."positionSeconds", 0) AS "positionSeconds",
        COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) AS "durationSeconds",
        us."lastPlayedAt",
        m.title AS "mediaTitle",
        m."posterUrl", m."fanartUrl",
        'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
          || COALESCE(' - ' || e.title, '') AS "episodeLabel",
        CASE WHEN COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) > 0
             THEN ROUND((COALESCE(ps_next."positionSeconds", c."positionSeconds", 0)
                        / COALESCE(ps_next."durationSeconds", c."durationSeconds", 1)) * 100)
             ELSE 0 END AS "progressPercent"
      FROM combined c
      JOIN user_series us ON us."mediaId" = c."mediaId"
      JOIN media m ON m.id = c."mediaId"
      JOIN episodes e ON e.id = c."episodeId"
      JOIN seasons s ON s.id = e."seasonId"
      LEFT JOIN LATERAL (
        SELECT mf2.id FROM media_files mf2
        WHERE mf2."mediaId" = c."mediaId" AND mf2."episodeId" = c."episodeId"
        ORDER BY mf2.id DESC LIMIT 1
      ) mf ON c."mediaFileId" IS NULL
      LEFT JOIN playback_states ps_next ON ps_next."userId" = $1 AND ps_next."mediaId" = c."mediaId" AND ps_next."episodeId" = c."episodeId"
      WHERE COALESCE(ps_next.completed, false) = false
        AND COALESCE(c."mediaFileId", mf.id) IS NOT NULL${libFilter}`,
      params,
    );
    for (const s of seriesItems) {
      s.mediaType = 'series';
      s.progressPercent = Number(s.progressPercent);
    }

    return [...movies, ...seriesItems]
      .sort(
        (a, b) =>
          new Date(b.lastPlayedAt).getTime() -
          new Date(a.lastPlayedAt).getTime(),
      )
      .slice(0, 20);
  }

  async getHistory(
    userId: number,
    page: number,
    limit: number,
    accessibleLibraryIds?: number[] | null,
  ): Promise<{ data: WatchHistoryItem[]; total: number }> {
    if (
      accessibleLibraryIds !== undefined &&
      accessibleLibraryIds !== null &&
      accessibleLibraryIds.length === 0
    ) {
      return { data: [], total: 0 };
    }
    const useAcl =
      accessibleLibraryIds !== undefined && accessibleLibraryIds !== null;

    // No dedup needed — one state per (mediaId, episodeId) by design
    const countResult = await this.repo.query(
      `SELECT COUNT(*) AS cnt
       FROM playback_states ps
       WHERE ps."userId" = $1 AND ps."positionSeconds" >= 10${useAcl ? ` AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = ps."mediaId" AND mAcl."libraryId" = ANY($2))` : ''}`,
      useAcl ? [userId, accessibleLibraryIds] : [userId],
    );
    const total = Number(countResult[0]?.cnt ?? 0);

    const data: WatchHistoryItem[] = await this.repo.query(
      `SELECT
         ps.id, ps."mediaId", ps."mediaFileId", ps."episodeId",
         ps."positionSeconds", ps."durationSeconds", ps.completed,
         ps."lastPlayedAt",
         m.title AS "mediaTitle", m.type AS "mediaType",
         m."posterUrl", m."fanartUrl",
         CASE WHEN ps."durationSeconds" > 0
              THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
              ELSE 0 END AS "progressPercent",
         CASE WHEN ps."episodeId" IS NOT NULL
              THEN 'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
                   || COALESCE(' - ' || e.title, '')
              ELSE NULL END AS "episodeLabel"
       FROM playback_states ps
       JOIN media m ON m.id = ps."mediaId"
       LEFT JOIN episodes e ON e.id = ps."episodeId"
       LEFT JOIN seasons s ON s.id = e."seasonId"
       WHERE ps."userId" = $1 AND ps."positionSeconds" >= 10${useAcl ? ` AND m."libraryId" = ANY($4)` : ''}
       ORDER BY ps."lastPlayedAt" DESC
       LIMIT $2 OFFSET $3`,
      useAcl
        ? [userId, limit, (page - 1) * limit, accessibleLibraryIds]
        : [userId, limit, (page - 1) * limit],
    );

    for (const item of data) {
      item.progressPercent = Number(item.progressPercent);
    }

    return { data, total };
  }

  async deleteState(
    userId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<void> {
    const state = await this.findState(userId, mediaId, episodeId);
    if (state) await this.repo.remove(state);
  }

  async getWatchedMediaIds(
    userId: number,
    accessibleLibraryIds?: number[] | null,
  ): Promise<number[]> {
    if (
      accessibleLibraryIds !== undefined &&
      accessibleLibraryIds !== null &&
      accessibleLibraryIds.length === 0
    ) {
      return [];
    }
    const useAcl =
      accessibleLibraryIds !== undefined && accessibleLibraryIds !== null;
    const movieFilter = useAcl ? ` AND m."libraryId" = ANY($2)` : '';
    const seriesFilter = useAcl
      ? ` AND EXISTS (SELECT 1 FROM media m2 WHERE m2.id = s."mediaId" AND m2."libraryId" = ANY($2))`
      : '';
    const params: unknown[] = useAcl
      ? [userId, accessibleLibraryIds]
      : [userId];

    const rows: { id: number }[] = await this.repo.query(
      `
      SELECT DISTINCT ps."mediaId" AS id
      FROM playback_states ps
      JOIN media m ON m.id = ps."mediaId"
      WHERE ps."userId" = $1 AND ps.completed = true AND m.type = 'movie'${movieFilter}

      UNION

      SELECT s."mediaId" AS id
      FROM seasons s
      JOIN episodes e ON e."seasonId" = s.id
      LEFT JOIN playback_states ps
        ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
      WHERE s."seasonNumber" > 0 AND e."hasFile" = true${seriesFilter}
      GROUP BY s."mediaId"
      HAVING COUNT(*) > 0 AND COUNT(*) = COUNT(ps.id)
      `,
      params,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Bulk-mark every episode with a file in non-special seasons as watched or
   * unwatched. Caller is expected to refresh its episode watched list (via
   * {@link getWatchedEpisodeIds}) — we don't return the full list here to
   * keep the payload small.
   */
  async toggleSeriesWatched(
    userId: number,
    mediaId: number,
    watched: boolean,
  ): Promise<{ watched: boolean }> {
    if (watched) {
      // Upsert a completed playback_state for every episode with a file in
      // non-special seasons. We use the partial unique index
      // idx_playback_user_episode (userId, episodeId) WHERE episodeId IS NOT NULL.
      await this.repo.query(
        `
        INSERT INTO playback_states
          ("userId", "mediaId", "mediaFileId", "episodeId",
           "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
        SELECT $1, $2,
               (SELECT mf.id FROM media_files mf
                 WHERE mf."episodeId" = e.id
                 ORDER BY mf.id DESC LIMIT 1),
               e.id,
               0,
               COALESCE(
                 (SELECT (mf2."streamInfo"->>'durationSeconds')::float FROM media_files mf2
                   WHERE mf2."episodeId" = e.id
                   ORDER BY mf2.id DESC LIMIT 1),
                 0
               ),
               true,
               NOW()
        FROM episodes e
        JOIN seasons s ON s.id = e."seasonId"
        WHERE s."mediaId" = $2
          AND s."seasonNumber" > 0
          AND e."hasFile" = true
        ON CONFLICT ("userId", "episodeId") WHERE "episodeId" IS NOT NULL
        DO UPDATE SET
          completed = true,
          "positionSeconds" = 0,
          "lastPlayedAt" = NOW()
        `,
        [userId, mediaId],
      );
    } else {
      await this.repo.query(
        `
        UPDATE playback_states
           SET completed = false,
               "positionSeconds" = 0,
               "lastPlayedAt" = NOW()
         WHERE "userId" = $1
           AND "mediaId" = $2
           AND "episodeId" IS NOT NULL
        `,
        [userId, mediaId],
      );
    }

    return { watched };
  }

  async toggleWatched(
    userId: number,
    mediaId: number,
    mediaFileId: number,
    episodeId?: number,
  ): Promise<PlaybackState> {
    let state = await this.findState(userId, mediaId, episodeId);
    if (state) {
      state.completed = !state.completed;
      if (state.completed) {
        if (!state.durationSeconds && state.mediaFileId) {
          const file = await this.mediaFileRepo.findOne({
            where: { id: state.mediaFileId },
          });
          state.durationSeconds = file?.streamInfo?.durationSeconds ?? 0;
        }
        state.positionSeconds = 0;
      }
      state.lastPlayedAt = new Date();
      if (mediaFileId) state.mediaFileId = mediaFileId;
    } else {
      const file = await this.mediaFileRepo.findOne({
        where: { id: mediaFileId },
      });
      const duration = file?.streamInfo?.durationSeconds ?? 0;
      state = this.repo.create({
        userId,
        mediaId,
        mediaFileId,
        episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
        positionSeconds: 0,
        durationSeconds: duration,
        completed: true,
        lastPlayedAt: new Date(),
      });
    }
    return this.repo.save(state);
  }

  async hideFromContinueWatching(
    userId: number,
    mediaId: number,
  ): Promise<void> {
    await this.repo.update(
      { userId, mediaId },
      { hiddenFromContinueWatching: true },
    );
  }
}
