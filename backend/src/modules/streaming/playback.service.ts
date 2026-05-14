import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { User } from '../users/entities/user.entity';
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

/**
 * Under this many seconds of stored progress, we surface the item in
 * continue-watching (so the user can jump back in) but resume from 0.
 * Avoids "reprendre à 3s" after an accidental click.
 */
const RESUME_FROM_START_UNDER_SECONDS = 10;

/** Postgres foreign-key violation. Library refresh can drop the parent media
 *  row mid-session; cascade clears existing playback_states, then a beacon
 *  arrives for that mediaId and the fresh INSERT trips this FK. */
const PG_FK_VIOLATION = '23503';

@Injectable()
export class PlaybackService implements OnModuleInit {
  private readonly log = new Logger(PlaybackService.name);

  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
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
         AND ps."positionSeconds" > 0
       ORDER BY ps."lastPlayedAt" DESC
       LIMIT 1`,
      [userId, mediaId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    const storedPos = Number(r.positionSeconds);
    return {
      mediaFileId: r.mediaFileId,
      episodeId: r.episodeId,
      positionSeconds:
        storedPos < RESUME_FROM_START_UNDER_SECONDS ? 0 : storedPos,
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

  /**
   * Progress percent (0–100) per episode for in-progress states of a series.
   * Excludes completed episodes (watched = shown separately by
   * {@link getWatchedEpisodeIds}). Used by the seasons panel to draw the
   * resume bar on episode cards.
   */
  async getEpisodeProgress(
    userId: number,
    mediaId: number,
  ): Promise<Record<number, number>> {
    const rows: { episodeId: number; percent: string }[] =
      await this.repo.query(
        `SELECT ps."episodeId",
                ROUND((ps."positionSeconds" / ps."durationSeconds") * 100) AS percent
         FROM playback_states ps
         WHERE ps."userId" = $1 AND ps."mediaId" = $2
           AND ps."episodeId" IS NOT NULL
           AND ps.completed = false
           AND ps."durationSeconds" > 0
           AND ps."positionSeconds" > 0`,
        [userId, mediaId],
      );
    const out: Record<number, number> = {};
    for (const r of rows) {
      const p = Number(r.percent);
      if (p > 0 && p < 100) out[r.episodeId] = p;
    }
    return out;
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
  ): Promise<PlaybackState | null> {
    if (!mediaId || !body.mediaFileId) {
      throw new BadRequestException('mediaId and mediaFileId are required');
    }
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
      state.mediaFile = { id: body.mediaFileId } as MediaFile;
    } else {
      state = this.repo.create({
        user: { id: userId } as User,
        media: { id: mediaId } as Media,
        mediaFile: { id: body.mediaFileId } as MediaFile,
        episode:
          body.episodeId != null ? ({ id: body.episodeId } as Episode) : null,
        positionSeconds: pos,
        durationSeconds: dur || 0,
        completed,
        lastPlayedAt: new Date(),
      });
    }

    try {
      return await this.repo.save(state);
    } catch (err) {
      if ((err as { code?: string })?.code === PG_FK_VIOLATION) return null;
      throw err;
    }
  }

  /**
   * Mark a playback session as started. Creates the playback_states row if
   * missing and stamps `playedAt = NOW()` so the media appears in the user's
   * watch history (history = sessions started, not a progress threshold).
   * Called by the streaming controller at playback-info time.
   */
  async markSessionStarted(
    userId: number,
    mediaId: number,
    mediaFileId: number,
    episodeId?: number | null,
  ): Promise<void> {
    const state = await this.findState(userId, mediaId, episodeId ?? undefined);
    const now = new Date();
    if (state) {
      state.playedAt = now;
      state.lastPlayedAt = now;
      if (mediaFileId) state.mediaFileId = mediaFileId;
      await this.repo.save(state);
    } else {
      await this.repo.save({
        user: { id: userId },
        media: { id: mediaId },
        mediaFile: mediaFileId ? { id: mediaFileId } : null,
        episode: episodeId != null ? { id: episodeId } : null,
        positionSeconds: 0,
        durationSeconds: 0,
        completed: false,
        lastPlayedAt: now,
        playedAt: now,
      } as Partial<PlaybackState>);
    }
  }

  async getContinueWatching(
    userId: number,
    accessibleLibraryIds: number[],
  ): Promise<ContinueWatchingItem[]> {
    if (accessibleLibraryIds.length === 0) return [];
    const libFilter = ` AND m."libraryId" = ANY($2)`;
    const params: unknown[] = [userId, accessibleLibraryIds];
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
      m.positionSeconds = Number(m.positionSeconds);
      m.progressPercent = Number(m.progressPercent);
      if (m.positionSeconds < RESUME_FROM_START_UNDER_SECONDS) {
        m.positionSeconds = 0;
        m.progressPercent = 0;
      }
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
        -- Highest (seasonNumber, episodeNumber) among completed episodes —
        -- ordering by lastPlayedAt ties when the user bulk-marks a season,
        -- which would make next_ep target an arbitrary earlier episode.
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."episodeId",
               s."seasonNumber", e."episodeNumber"
        FROM playback_states ps
        JOIN episodes e ON e.id = ps."episodeId"
        JOIN seasons s ON s.id = e."seasonId"
        WHERE ps."userId" = $1 AND ps.completed = true AND ps."episodeId" IS NOT NULL
        ORDER BY ps."mediaId", s."seasonNumber" DESC, e."episodeNumber" DESC
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
      s.positionSeconds = Number(s.positionSeconds);
      s.progressPercent = Number(s.progressPercent);
      if (s.positionSeconds < RESUME_FROM_START_UNDER_SECONDS) {
        s.positionSeconds = 0;
        s.progressPercent = 0;
      }
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
    accessibleLibraryIds: number[],
  ): Promise<{ data: WatchHistoryItem[]; total: number }> {
    if (accessibleLibraryIds.length === 0) return { data: [], total: 0 };

    // No dedup needed — one state per (mediaId, episodeId) by design
    const countResult = await this.repo.query(
      `SELECT COUNT(*) AS cnt
       FROM playback_states ps
       WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
         AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = ps."mediaId" AND mAcl."libraryId" = ANY($2))`,
      [userId, accessibleLibraryIds],
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
       WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
         AND m."libraryId" = ANY($4)
       ORDER BY ps."playedAt" DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, (page - 1) * limit, accessibleLibraryIds],
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
    accessibleLibraryIds: number[],
  ): Promise<number[]> {
    if (accessibleLibraryIds.length === 0) return [];

    const rows: { id: number }[] = await this.repo.query(
      `
      SELECT DISTINCT ps."mediaId" AS id
      FROM playback_states ps
      JOIN media m ON m.id = ps."mediaId"
      WHERE ps."userId" = $1 AND ps.completed = true AND m.type = 'movie'
        AND m."libraryId" = ANY($2)

      UNION

      SELECT s."mediaId" AS id
      FROM seasons s
      JOIN episodes e ON e."seasonId" = s.id
      LEFT JOIN playback_states ps
        ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
      WHERE s."seasonNumber" > 0 AND e."hasFile" = true
        AND EXISTS (SELECT 1 FROM media m2 WHERE m2.id = s."mediaId" AND m2."libraryId" = ANY($2))
      GROUP BY s."mediaId"
      HAVING COUNT(*) > 0 AND COUNT(*) = COUNT(ps.id)
      `,
      [userId, accessibleLibraryIds],
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

  /**
   * Bulk-mark every episode with a file in a single season as watched or
   * unwatched. Same semantics as {@link toggleSeriesWatched} but scoped to
   * one season.
   */
  async toggleSeasonWatched(
    userId: number,
    mediaId: number,
    seasonId: number,
    watched: boolean,
  ): Promise<{ watched: boolean }> {
    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId } },
    });
    if (!episodes.length) return { watched };
    const episodeIds = episodes.map((e) => e.id);
    const now = new Date();

    if (watched) {
      const withFile = episodes.filter((e) => e.hasFile);
      if (!withFile.length) return { watched };

      // Latest media file per episode (highest id).
      const files = await this.mediaFileRepo.find({
        where: { episode: { id: In(withFile.map((e) => e.id)) } },
        order: { id: 'DESC' },
      });
      const latestByEpisode = new Map<number, MediaFile>();
      for (const f of files) {
        if (!latestByEpisode.has(f.episodeId))
          latestByEpisode.set(f.episodeId, f);
      }

      // Delete+recreate wins over ORM-less upsert: the partial unique index
      // (userId, episodeId) WHERE episodeId IS NOT NULL isn't reachable from
      // repo.upsert(), and a season is small enough that two round-trips are
      // fine.
      await this.repo.delete({
        user: { id: userId },
        episode: { id: In(withFile.map((e) => e.id)) },
      });

      const rows = withFile
        .map((ep) => {
          const file = latestByEpisode.get(ep.id);
          if (!file) return null;
          return {
            user: { id: userId },
            media: { id: mediaId },
            mediaFile: { id: file.id },
            episode: { id: ep.id },
            positionSeconds: 0,
            durationSeconds: file.streamInfo?.durationSeconds ?? 0,
            completed: true,
            lastPlayedAt: now,
            playedAt: null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length) {
        await this.repo.save(rows as Partial<PlaybackState>[]);
      }
    } else {
      await this.repo.update(
        {
          user: { id: userId },
          media: { id: mediaId },
          episode: { id: In(episodeIds) },
        },
        {
          completed: false,
          positionSeconds: 0,
          lastPlayedAt: now,
        },
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
    const existing = await this.findState(userId, mediaId, episodeId);
    const willBeCompleted = existing ? !existing.completed : true;

    // Always build from relation properties — RelationId virtuals
    // (userId/mediaId/mediaFileId) are read-only and don't persist, so inserts
    // built from them hit NOT NULL on the FK columns.
    const state =
      existing ??
      this.repo.create({
        user: { id: userId } as User,
        media: { id: mediaId } as Media,
        episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
      });

    state.completed = willBeCompleted;
    state.lastPlayedAt = new Date();
    if (mediaFileId) state.mediaFile = { id: mediaFileId } as MediaFile;

    if (willBeCompleted) {
      state.positionSeconds = 0;
      if (!state.durationSeconds) {
        const fileId = mediaFileId || state.mediaFileId;
        if (fileId) {
          const file = await this.mediaFileRepo.findOne({
            where: { id: fileId },
          });
          state.durationSeconds = file?.streamInfo?.durationSeconds ?? 0;
        }
      }
    }

    return this.repo.save(state);
  }

  async hideFromContinueWatching(
    userId: number,
    mediaId: number,
  ): Promise<void> {
    await this.repo.update(
      { user: { id: userId }, media: { id: mediaId } },
      { hiddenFromContinueWatching: true },
    );
  }
}
