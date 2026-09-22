import { Pipe, PipeTransform, inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';
import { AuthService } from '../services/auth.service';

export type ImageSize = 'thumb' | 'medium' | 'full';

/** A Live TV channel logo can belong to a restricted group, so unlike every
 *  other local image it requires an authenticated caller — see LivetvController. */
const LIVETV_LOGO_PATH = '/api/livetv/channels/';

/** Append the pre-generated variant to a local image URL. Remote URLs (TMDB
 *  direct, manual override) are left untouched — see {@link ResolveUrlPipe}. */
export function imageUrlWithSize(url: string, size: ImageSize): string {
  if (!url.startsWith('/api/images/') && !url.startsWith(LIVETV_LOGO_PATH)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}size=${size}`;
}

/** A same-origin web request already carries the auth cookie; native/TV clients
 *  fetch cross-origin and can't attach one, so the token rides in the query,
 *  exactly like an HLS segment URL (see `livetv.controller.ts`'s `withToken`). */
export function withLiveTvLogoToken(url: string, token: string | null): string {
  if (!token || !url.startsWith(LIVETV_LOGO_PATH)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Resolves a relative URL against the configured server base. When given a
 * second argument matching one of our local image sizes (thumb / medium /
 * full), appends `?size=…` so the backend serves the matching pre-generated
 * variant. The size param is appended ONLY for `/api/images/...` URLs — a
 * remote URL (TMDB direct, manual override) is left untouched and the
 * backend falls back to `full` for older entities that haven't been
 * refreshed since multi-size support landed.
 */
@Pipe({ name: 'resolveUrl', standalone: true })
export class ResolveUrlPipe implements PipeTransform {
  private readonly config = inject(ServerConfigService);
  private readonly auth = inject(AuthService);

  transform(url: string | null | undefined, size?: ImageSize): string | null {
    if (!url) return null;
    let resolved = size ? imageUrlWithSize(url, size) : url;
    resolved = withLiveTvLogoToken(resolved, this.auth.playbackToken);
    return this.config.resolveUrl(resolved);
  }
}
