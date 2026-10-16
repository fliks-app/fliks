import { bridgeFetch } from '../bridge/server-bridge';

/** Playback reads served by fliks-server (`/internal/playback/*`, server/docs/bridge.md). */
export interface RecommendationItem {
  media: {
    id: number;
    title: string;
    type: string;
    year: number;
    posterUrl: string | null;
    fanartUrl: string | null;
    additionalFanartUrls: string[];
    genres: string[];
    available: boolean;
  };
  becauseTitle: string;
  score: number;
}

export interface WatchHistoryItem {
  id: number;
  mediaId: number;
  mediaFileId: number | null;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  completed: boolean;
  lastPlayedAt: string;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  stillUrl: string | null;
  episodeLabel: string | null;
}

const query = (userId: number, extra: Record<string, string | number>) =>
  new URLSearchParams({ userId: String(userId), ...extra }).toString();

export const getTopGenres = (userId: number) =>
  bridgeFetch(`/internal/playback/top-genres?${query(userId, {})}`) as Promise<
    { genre: string; weight: number }[]
  >;

export const getRecommendations = (
  userId: number,
  libraryIds: number[],
  limit: number,
) =>
  bridgeFetch(
    `/internal/playback/recommendations?${query(userId, {
      libraryIds: libraryIds.join(','),
      limit,
    })}`,
  ) as Promise<RecommendationItem[]>;

export const getHistory = (
  userId: number,
  page: number,
  limit: number,
  libraryIds: number[],
) =>
  bridgeFetch(
    `/internal/playback/history?${query(userId, {
      page,
      limit,
      libraryIds: libraryIds.join(','),
    })}`,
  ) as Promise<{ data: WatchHistoryItem[]; total: number }>;
