import type { MediaType } from './enums/media-type.enum';

export interface KindDescriptor {
  /** Route segment of the detail page, without the leading slash. */
  segment: string;
  /** The kind in the metadata API path, the `/add/*` route and the view-transition name. */
  providerSegment: string;
  /** Key of the request-type label. */
  requestLabelKey: string;
  /** The kind is made of seasons and episodes. */
  hasSeasons: boolean;
}

/** Adding a `MediaType` fails to compile until it is described here. */
export const KIND_REGISTRY: Record<MediaType, KindDescriptor> = {
  movie: {
    segment: 'movies',
    providerSegment: 'movie',
    requestLabelKey: 'requests.type_movie',
    hasSeasons: false,
  },
  series: {
    segment: 'series',
    providerSegment: 'tv',
    requestLabelKey: 'requests.type_series',
    hasSeasons: true,
  },
  book: {
    segment: 'books',
    providerSegment: 'book',
    requestLabelKey: 'kinds.book',
    hasSeasons: false,
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
