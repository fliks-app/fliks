import type { MediaType } from './enums/media-type.enum';

export type MediaFamily = 'video' | 'text' | 'audio' | 'image';
/** `work` is the whole title, `group` a season, a volume or a disc, `item` an episode, an issue or a track. */
export type AcquisitionLevel = 'work' | 'group' | 'item';

/** A level below the work: the key of the release modal title when it is searched. */
export interface LevelDescriptor {
  releasesTitleKey: string;
}

export interface KindDescriptor {
  /** Route segment of the detail page, without the leading slash. */
  segment: string;
  /** The kind in the metadata API path, the `/add/*` route and the view-transition name. */
  providerSegment: string;
  /** Key of the request-type label. */
  requestLabelKey: string;
  /** Key of the label naming the kind in library settings. */
  libraryLabelKey: string;
  /** The kind is made of seasons and episodes. */
  hasSeasons: boolean;
  /** The families a want of this kind can name. */
  families: readonly MediaFamily[];
  /** The levels below the work this kind has; a kind with none is acquired as a whole. */
  levels: { group?: LevelDescriptor; item?: LevelDescriptor };
}

export const WORK_RELEASES_TITLE_KEY = 'media_detail.releases_title';

/** Adding a `MediaType` fails to compile until it is described here. */
export const KIND_REGISTRY: Record<MediaType, KindDescriptor> = {
  movie: {
    segment: 'movies',
    providerSegment: 'movie',
    requestLabelKey: 'requests.type_movie',
    libraryLabelKey: 'settings.libraries.media_type_movie',
    hasSeasons: false,
    families: ['video'],
    levels: {},
  },
  series: {
    segment: 'series',
    providerSegment: 'tv',
    requestLabelKey: 'requests.type_series',
    libraryLabelKey: 'settings.libraries.media_type_series',
    hasSeasons: true,
    families: ['video'],
    levels: {
      group: { releasesTitleKey: 'media_detail.season_packs_title' },
      item: { releasesTitleKey: 'media_detail.ep_releases_title' },
    },
  },
  book: {
    segment: 'books',
    providerSegment: 'book',
    requestLabelKey: 'kinds.book',
    libraryLabelKey: 'settings.libraries.media_type_book',
    hasSeasons: false,
    families: ['text', 'audio'],
    levels: {},
  },
  comic: {
    segment: 'comics',
    providerSegment: 'comic',
    requestLabelKey: 'kinds.comic',
    libraryLabelKey: 'settings.libraries.media_type_comic',
    hasSeasons: false,
    families: ['image'],
    levels: { item: { releasesTitleKey: 'media_detail.issue_releases_title' } },
  },
};

export const MEDIA_KINDS = Object.keys(KIND_REGISTRY) as MediaType[];

export function isMediaKind(value: unknown): value is MediaType {
  return typeof value === 'string' && Object.hasOwn(KIND_REGISTRY, value);
}

/** Router link of a title's detail page. */
export function mediaDetailLink(type: MediaType, id: number | string): string[] {
  return ['/' + KIND_REGISTRY[type].segment, String(id)];
}

/** The kind served at a detail route segment, if any. */
export function kindFromSegment(segment: string | null | undefined): MediaType | undefined {
  return MEDIA_KINDS.find((k) => KIND_REGISTRY[k].segment === segment);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled media kind: ${String(value)}`);
}

/** The kind a list filter stands for when it must name one: "all" falls on this one. */
export const DEFAULT_LIST_KIND: MediaType = 'movie';

export function kindOfListFilter(filter: 'all' | MediaType): MediaType {
  return filter === 'all' ? DEFAULT_LIST_KIND : filter;
}

/** Regex alternations over every kind's detail segment and `/add/*` segment. */
export const DETAIL_SEGMENTS_PATTERN = MEDIA_KINDS.map((k) => KIND_REGISTRY[k].segment).join('|');
export const PROVIDER_SEGMENTS_PATTERN = MEDIA_KINDS.map((k) => KIND_REGISTRY[k].providerSegment).join('|');

/** The kind served at an `/add/<segment>` route segment, if any. */
export function kindFromProviderSegment(segment: string | null | undefined): MediaType | undefined {
  return MEDIA_KINDS.find((k) => KIND_REGISTRY[k].providerSegment === segment);
}

/** The release modal title of a target's level; the work's own when the kind has no such level. */
export function releasesTitleKey(kind: MediaType, level: AcquisitionLevel): string {
  const levels = KIND_REGISTRY[kind].levels;
  return (level === 'work' ? undefined : levels[level])?.releasesTitleKey ?? WORK_RELEASES_TITLE_KEY;
}
