import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePause, LucidePlay, LucideX } from '@lucide/angular';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../directives/cached-src.directive';

/** Bar over the page while playback is on another device; the player route holds the full controls. */
@Component({
  selector: 'app-cast-overlay',
  imports: [LucidePause, LucidePlay, LucideX, CachedSrcDirective, ResolveUrlPipe, TranslatePipe],
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  protected readonly session = inject(PlaybackSession);
  private readonly device = inject(DeviceService);

  /** The cast or remote output; null on a TV, which never casts, and while playing locally. */
  protected readonly output = computed(() => (this.device.isTv() || this.session.isLocal() ? null : this.session.output()));

  protected open(): void {
    this.session.openPlayer();
  }

  protected togglePlay(): void {
    this.session.command({ type: 'toggle' });
  }
}
