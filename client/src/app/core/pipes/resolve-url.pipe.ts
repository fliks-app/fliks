import { Pipe, PipeTransform, inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';

export type ImageSize = 'thumb' | 'medium' | 'full';

/** Append the pre-generated variant to a local image URL. Remote URLs (TMDB
 *  direct, manual override) are left untouched — see {@link ResolveUrlPipe}. */
export function imageUrlWithSize(url: string, size: ImageSize): string {
  if (!url.startsWith('/api/images/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}size=${size}`;
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

  transform(url: string | null | undefined, size?: ImageSize): string | null {
    if (!url) return null;
    const resolved = size ? imageUrlWithSize(url, size) : url;
    return this.config.resolveUrl(resolved);
  }
}
