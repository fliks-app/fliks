import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { StreamsApiService, ActiveStream } from '../../../core/services/api/streams-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { LucidePause, LucidePlay, LucideSquare } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';

@Component({
  selector: 'app-system-streams',
  imports: [UpperCasePipe, RouterLink, TranslateModule, ResolveUrlPipe, LucidePause, LucidePlay, LucideSquare],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './streams.html',
})
export class SystemStreamsComponent implements OnInit, OnDestroy {
  private readonly streamsApi = inject(StreamsApiService);
  private readonly confirmation = inject(ConfirmationService);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  readonly streams = signal<ActiveStream[]>([]);
  readonly loading = signal(true);
  readonly pausedSessions = signal(new Set<string>());

  ngOnInit() {
    this.refresh();
    this.intervalId = setInterval(() => this.refresh(), 5_000);
  }

  ngOnDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  async refresh() {
    try {
      const data = await this.streamsApi.list();
      this.streams.set(data);
    } catch {
      // ignore
    } finally {
      this.loading.set(false);
    }
  }

  async togglePause(stream: ActiveStream) {
    const paused = this.pausedSessions();
    const isPaused = paused.has(stream.sessionId);
    try {
      await this.streamsApi.sendCommand(stream.sessionId, isPaused ? 'play' : 'pause');
      const next = new Set(paused);
      if (isPaused) next.delete(stream.sessionId); else next.add(stream.sessionId);
      this.pausedSessions.set(next);
    } catch { /* ignore */ }
  }

  isPaused(sessionId: string): boolean {
    return this.pausedSessions().has(sessionId);
  }

  async confirmStop(stream: ActiveStream) {
    const confirmed = await this.confirmation.confirm({
      title: 'Arrêter la lecture',
      message: `Arrêter la lecture de "${stream.mediaTitle}"${stream.username ? ` pour ${stream.username}` : ''} ?`,
      confirmLabel: 'Arrêter',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.streamsApi.sendCommand(stream.sessionId, 'stop');
      this.streams.update((s) => s.filter((x) => x.sessionId !== stream.sessionId));
    } catch { /* ignore */ }
  }

  modeLabel(mode: string): string {
    switch (mode) {
      case 'transcode': return 'Transcodage';
      case 'remux': return 'Remux';
      case 'directplay': return 'Lecture directe';
      default: return mode;
    }
  }

  modeBadgeClass(mode: string): string {
    switch (mode) {
      case 'transcode': return 'badge-warning';
      case 'remux': return 'badge-info';
      case 'directplay': return 'badge-success';
      default: return 'badge-ghost';
    }
  }

  formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  mediaLink(s: ActiveStream): string {
    const prefix = s.mediaType === 'movie' ? '/movies' : '/series';
    return `${prefix}/${s.mediaId}`;
  }

  episodeLink(s: ActiveStream): string {
    return `/series/${s.mediaId}/episode/${s.episodeId}`;
  }

  formatBitrate(bps: number): string {
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(0)} Mbps`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
    return `${bps} bps`;
  }
}
