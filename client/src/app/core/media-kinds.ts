import type { MediaType } from './enums/media-type.enum';

export interface KindDescriptor {
  /** Route segment of the detail page, without the leading slash. */
  segment: string;
  /** Metadata-provider path segment for this kind. */
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

/** The kind a list filter stands for when it must pick one: "all" falls on the first kind. */
export function filterKind(filter: 'all' | MediaType): MediaType {
  return filter === 'all' ? MEDIA_KINDS[0] : filter;
}
