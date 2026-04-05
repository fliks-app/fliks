import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import {
  LucideCaptions,
  LucideCast,
  LucideCheck,
  LucideChevronDown,
  LucideHeadphones,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSettings,
  LucideSquare,
  LucideX,
} from '@lucide/angular';

@Component({
  selector: 'app-cast-overlay',
  imports: [
    LucideCaptions, LucideCast, LucideCheck, LucideChevronDown,
    LucideHeadphones, LucidePause, LucidePlay, LucideRotateCcw, LucideRotateCw,
    LucideSettings, LucideSquare, LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  readonly cast = inject(CastService);
  readonly cp = inject(CastPlayerService);
  // Drag state for progress bar
  readonly dragging = signal(false);
  readonly dragTime = signal(0);

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.cp.expanded()) this.cp.expanded.set(false);
  }

  toggle() {
    this.cp.expanded.update(v => !v);
  }

  progressPercent(): number {
    const d = this.cast.duration() || 1;
    return (this.cast.currentTime() / d) * 100;
  }

  dragPercent(): number {
    const d = this.cast.duration() || 1;
    return (this.dragTime() / d) * 100;
  }

  formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  selectSubtitle(sub: any | null) {
    if (!sub) {
      this.cp.activeSubtitleId.set(null);
      this.cast.setActiveSubtitle(0);
      this.cp.changeBurnIn(null);
      return;
    }
    this.cp.activeSubtitleId.set(sub.id);
    if (sub.burnIn) {
      this.cp.changeBurnIn(sub.castTrackId ?? 0);
    } else if (sub.castTrackId) {
      this.cast.setActiveSubtitle(sub.castTrackId);
    }
  }

  selectAudio(track: any | null) {
    if (!track) return;
    this.cp.activeAudioTrackId.set(track.id);
    const idx = parseInt(track.id.replace(/^(si-|shaka-|audio-)/, ''), 10);
    this.cp.changeAudio(idx);
  }

  selectQuality(quality: any) {
    if (quality.id === this.cp.activeQualityId()) return;
    this.cp.changeQuality(quality.id);
  }

  disconnect() {
    this.cast.disconnect();
    this.cp.clear();
    this.cp.expanded.set(false);
  }

  onProgressDown(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.dragging.set(true);
    this.updateDrag(event, bar);

    const onMove = (e: PointerEvent) => this.updateDrag(e, bar);
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      this.cast.seek(this.dragTime());
      this.dragging.set(false);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }

  private updateDrag(e: PointerEvent, bar: HTMLElement) {
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.dragTime.set(pct * (this.cast.duration() || 0));
  }
}
