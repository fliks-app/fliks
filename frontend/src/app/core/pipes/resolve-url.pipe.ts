import { Pipe, PipeTransform, inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';

export type ImageSize = 'thumb' | 'medium' | 'full';

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
    let resolved = url;
    if (size && url.startsWith('/api/images/')) {
      const sep = url.includes('?') ? '&' : '?';
      resolved = `${url}${sep}size=${size}`;
    }
    return this.config.resolveUrl(resolved);
  }
}
