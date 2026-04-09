import { Pipe, PipeTransform, inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';

@Pipe({ name: 'resolveUrl', standalone: true })
export class ResolveUrlPipe implements PipeTransform {
  private readonly config = inject(ServerConfigService);

  transform(url: string | null | undefined): string | null {
    if (!url) return null;
    return this.config.resolveUrl(url);
  }
}
