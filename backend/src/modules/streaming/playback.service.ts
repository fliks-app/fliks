import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlaybackState } from './entities/playback-state.entity';

export interface WatchHistoryItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
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
  mediaFileId: number;
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
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

@Injectable()
export class PlaybackService {
  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
  ) {}

  async getState(
    userId: number,
    mediaFileId: number,
  ): Promise<PlaybackState | null> {
    return this.repo.findOne({ where: { userId, mediaFileId } });
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
    mediaFileId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaId: number;
      episodeId?: number;
    },
  ): Promise<PlaybackState> {
    let state = await this.repo.findOne({ where: { userId, mediaFileId } });

    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    // Completed if within 30s of end OR past 90% (like Jellyfin's MaxResumePct)
    const completed = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);

    if (state) {
      state.positionSeconds = pos;
      if (dur > 0) state.durationSeconds = dur;
      state.completed = completed;
      state.lastPlayedAt = new Date();
    } else {
      state = this.repo.create({
        userId,
        mediaFileId,
        mediaId: body.mediaId,
        episodeId: body.episodeId,
        positionSeconds: pos,
        durationSeconds: dur || 0,
        completed,
        lastPlayedAt: new Date(),
      });
    }

    return this.repo.save(state);
  }

  async getContinueWatching(userId: number): Promise<ContinueWatchingItem[]> {
    // 1. Movies: in-progress, deduplicated by mediaId (1 query)
    const movies: ContinueWatchingItem[] = await this.repo.query(
      `SELECT DISTINCT ON (ps."mediaId")
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
         AND ps."positionSeconds" > 0
         AND m.type = 'movie'
       ORDER BY ps."mediaId", ps."lastPlayedAt" DESC`,
      [userId],
    );
    for (const m of movies) {
      m.mediaType = 'movie';
      m.episodeLabel = null;
      m.progressPercent = Number(m.progressPercent);
    }

    // 2. Series "next up" (1 query):
    //    For each series the user has watched, find the next episode after the last completed one.
    //    Uses a lateral join to efficiently find the next episode per series.
    const seriesItems: ContinueWatchingItem[] = await this.repo.query(
      `WITH user_series AS (
        -- Most recent playback per series
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."lastPlayedAt"
        FROM playback_states ps
        JOIN media m ON m.id = ps."mediaId"
        WHERE ps."userId" = $1 AND m.type = 'series'
        ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
      ),
      last_completed AS (
        -- Last completed episode per series (season/episode numbers)
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
        -- Episodes started but not completed (no completed episode exists for that series)
        SELECT DISTINCT ON (ps."mediaId")
               ps."mediaId", ps."episodeId", ps."mediaFileId",
               ps."positionSeconds", ps."durationSeconds"
        FROM playback_states ps
        WHERE ps."userId" = $1
          AND ps.completed = false AND ps."positionSeconds" > 0 AND ps."episodeId" IS NOT NULL
          AND ps."mediaId" NOT IN (SELECT "mediaId" FROM last_completed)
        ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
      ),
      next_ep AS (
        -- For series with a completed episode: find the next unwatched episode
        SELECT lc."mediaId",
               (SELECT e.id FROM episodes e
                JOIN seasons s ON s.id = e."seasonId"
                WHERE s."mediaId" = lc."mediaId" AND s."seasonNumber" > 0
                  AND (s."seasonNumber" > lc."seasonNumber"
                       OR (s."seasonNumber" = lc."seasonNumber" AND e."episodeNumber" > lc."episodeNumber"))
                ORDER BY s."seasonNumber", e."episodeNumber" LIMIT 1
               ) AS "episodeId"
        FROM last_completed lc
      ),
      combined AS (
        -- Merge: next episode after completed OR in-progress episode
        SELECT ne."mediaId", ne."episodeId", NULL::int AS "mediaFileId", 0.0 AS "positionSeconds", 0.0 AS "durationSeconds"
        FROM next_ep ne WHERE ne."episodeId" IS NOT NULL
        UNION ALL
        SELECT ip."mediaId", ip."episodeId", ip."mediaFileId", ip."positionSeconds", ip."durationSeconds"
        FROM in_progress ip
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
      LEFT JOIN playback_states ps_next ON ps_next."userId" = $1 AND ps_next."mediaFileId" = COALESCE(c."mediaFileId", mf.id)
      WHERE COALESCE(ps_next.completed, false) = false
        AND COALESCE(c."mediaFileId", mf.id) IS NOT NULL`,
      [userId],
    );
    for (const s of seriesItems) {
      s.mediaType = 'series';
      s.progressPercent = Number(s.progressPercent);
    }

    // 3. Merge and sort by lastPlayedAt
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
  ): Promise<{ data: WatchHistoryItem[]; total: number }> {
    const countResult = await this.repo.query(
      `SELECT COUNT(*) AS cnt
       FROM playback_states ps
       WHERE ps."userId" = $1 AND ps."positionSeconds" >= 10`,
      [userId],
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
       WHERE ps."userId" = $1 AND ps."positionSeconds" >= 10
       ORDER BY ps."lastPlayedAt" DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, (page - 1) * limit],
    );

    for (const item of data) {
      item.progressPercent = Number(item.progressPercent);
    }

    return { data, total };
  }

  async deleteState(userId: number, mediaFileId: number): Promise<void> {
    await this.repo.delete({ userId, mediaFileId });
  }

  /** Return mediaIds the user has fully watched (movies: any completed file; series: all hasFile episodes completed). */
  async getWatchedMediaIds(userId: number): Promise<number[]> {
    const rows: { id: number }[] = await this.repo.query(
      `
      SELECT DISTINCT ps."mediaId" AS id
      FROM playback_states ps
      JOIN media m ON m.id = ps."mediaId"
      WHERE ps."userId" = $1 AND ps.completed = true AND m.type = 'movie'

      UNION

      SELECT s."mediaId" AS id
      FROM seasons s
      JOIN episodes e ON e."seasonId" = s.id
      LEFT JOIN playback_states ps
        ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
      WHERE s."seasonNumber" > 0 AND e."hasFile" = true
      GROUP BY s."mediaId"
      HAVING COUNT(*) = COUNT(ps.id)
      `,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  /** Toggle watched status for a specific media file. */
  async toggleWatched(
    userId: number,
    mediaFileId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<PlaybackState> {
    let state = await this.repo.findOne({ where: { userId, mediaFileId } });
    if (state) {
      state.completed = !state.completed;
      if (state.completed) state.positionSeconds = 0;
      state.lastPlayedAt = new Date();
    } else {
      state = this.repo.create({
        userId,
        mediaFileId,
        mediaId,
        episodeId,
        positionSeconds: 0,
        durationSeconds: 0,
        completed: true,
        lastPlayedAt: new Date(),
      });
    }
    return this.repo.save(state);
  }

  /** Mark all playback states for a media as completed (hides from continue watching). */
  async hideFromContinueWatching(
    userId: number,
    mediaId: number,
  ): Promise<void> {
    await this.repo.update(
      { userId, mediaId },
      { completed: true, positionSeconds: 0 },
    );
  }
}
