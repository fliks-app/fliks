import { Injectable, Pipe, PipeTransform, inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';
import { AuthService } from '../services/auth.service';
import { SERVER_SINCE, ServerVersionService } from '../services/server-version.service';

export type ImageSize = 'thumb' | 'medium' | 'full';

/** A Live TV channel logo can belong to a restricted group, so unlike every
 *  other local image it requires an authenticated caller — see LivetvController. */
const LIVETV_LOGO_PATH = '/api/livetv/channels/';
/** Images only an authenticated caller reads. */
const AUTHED_IMAGE_PATHS = [LIVETV_LOGO_PATH, '/api/imports/orphans/cover'];

/** TMDB serves its own sizes: an `original` backdrop is up to 3840 px wide. */
const TMDB_ORIGINAL = /^(https:\/\/image\.tmdb\.org\/t\/p\/)original\//;
const TMDB_WIDTH: Record<ImageSize, string> = { thumb: 'w500', medium: 'w1280', full: 'original' };

/** A card is 150 to 200 CSS px wide: w342 covers it up to a 1.5 pixel ratio. */
function tmdbWidth(size: ImageSize): string {
  if (size === 'thumb' && (globalThis.devicePixelRatio ?? 1) <= 1.5) return 'w342';
  return TMDB_WIDTH[size];
}

/** Append the pre-generated variant to a local image URL. Provider artwork goes through the server's
 *  proxy when `proxy` (server `images.md` section E), else straight to the provider. */
export function imageUrlWithSize(url: string, size: ImageSize, proxy: boolean): string {
  if (proxy && /^https?:\/\//i.test(url)) return `/api/images/remote?url=${encodeURIComponent(url)}&size=${size}`;
  if (TMDB_ORIGINAL.test(url)) return url.replace(TMDB_ORIGINAL, `$1${tmdbWidth(size)}/`);
  if (!url.startsWith('/api/images/') && !url.startsWith(LIVETV_LOGO_PATH)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}size=${size}`;
}

/** Same-origin web requests carry the auth cookie; native/TV clients are cross-origin, so the token rides in the query like an HLS segment URL (see `withToken`). */
export function withAuthedImageToken(url: string, token: string | null): string {
  if (!token || !AUTHED_IMAGE_PATHS.some((p) => url.startsWith(p))) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** Resolves an image URL against the server base at `size` (`full` by default), see `imageUrlWithSize`. */
@Pipe({ name: 'resolveUrl' })
export class ResolveUrlPipe implements PipeTransform {
  private readonly config = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly version = inject(ServerVersionService);

  transform(url: string | null | undefined, size?: ImageSize): string | null {
    if (!url) return null;
    let resolved = imageUrlWithSize(url, size ?? 'full', this.version.supports(SERVER_SINCE.remoteImages));
    // Web already carries the auth cookie same-origin; only a native/TV client
    // needs the token riding in the query.
    if (this.config.isNative) resolved = withAuthedImageToken(resolved, this.auth.playbackToken);
    return this.config.resolveUrl(resolved);
  }
}

/** Image URLs against the connected server, for code that hands artwork to a sink outside a template. */
@Injectable({ providedIn: 'root' })
export class ImageUrls {
  private readonly config = inject(ServerConfigService);
  private readonly version = inject(ServerVersionService);

  resolve(url: string, size: ImageSize): string {
    return this.config.resolveUrl(imageUrlWithSize(url, size, this.version.supports(SERVER_SINCE.remoteImages)));
  }
}
