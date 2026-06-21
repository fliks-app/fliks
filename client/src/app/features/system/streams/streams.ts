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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { StreamsApiService, ActiveStream } from '../../../core/services/api/streams-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { LucideMessageSquare, LucidePause, LucidePlay, LucideSquare } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { parseDeviceLabel } from '../../../core/utils/format-device-label';

@Component({
  selector: 'app-system-streams',
  imports: [UpperCasePipe, RouterLink, TranslateModule, FormsModule, ResolveUrlPipe, LucideMessageSquare, LucidePause, LucidePlay, LucideSquare],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './streams.html',
})
export class SystemStreamsComponent implements OnInit, OnDestroy {
  private readonly streamsApi = inject(StreamsApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  readonly streams = signal<ActiveStream[]>([]);
  readonly loading = signal(true);
  readonly pausedSessions = signal(new Set<string>());
  readonly messageTarget = signal<ActiveStream | null>(null);
  readonly messageText = signal('');
  readonly messageBusy = signal(false);

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

  openMessage(stream: ActiveStream) {
    this.messageText.set('');
    this.messageTarget.set(stream);
  }

  closeMessage() {
    this.messageTarget.set(null);
    this.messageText.set('');
  }

  async sendMessage() {
    const target = this.messageTarget();
    const text = this.messageText().trim();
    if (!target || !text) return;
    this.messageBusy.set(true);
    try {
      await this.streamsApi.sendCommand(target.sessionId, 'message', text);
      this.toast.success(this.translate.instant('system.stream_message_sent'));
      this.closeMessage();
    } catch {
      // Failure toast is owned by the global error interceptor — surfacing
      // a generic "send failed" here on top would just stack two toasts.
    } finally {
      this.messageBusy.set(false);
    }
  }

  async confirmStop(stream: ActiveStream) {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('system.stream_stop'),
      message: this.translate.instant(
        stream.username
          ? 'system.stream_stop_confirm_user'
          : 'system.stream_stop_confirm',
        { title: stream.mediaTitle, user: stream.username },
      ),
      confirmLabel: this.translate.instant('system.stream_stop_action'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.streamsApi.sendCommand(stream.sessionId, 'stop');
      this.streams.update((s) => s.filter((x) => x.sessionId !== stream.sessionId));
    } catch { /* ignore */ }
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

  formatDevice(ua: string | null | undefined, systemName?: string | null): string {
    const label = parseDeviceLabel(ua ?? null, systemName);
    if (!label) return '';
    return this.translate.instant(label.key, label.params);
  }

  formatBitrate(bps: number): string {
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(0)} Mbps`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
    return `${bps} bps`;
  }

  /** Display label for a hardware-acceleration code (the per-session value the
   *  backend ships), falling back to the upper-cased code for unknowns. */
  hwLabel(hwAccel: string): string {
    const labels: Record<string, string> = {
      qsv: 'QSV',
      vaapi: 'VAAPI',
      nvenc: 'NVENC',
      videotoolbox: 'Apple VT',
      none: 'CPU',
    };
    return labels[hwAccel] ?? hwAccel.toUpperCase();
  }
}
