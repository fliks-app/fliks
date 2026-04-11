import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { formatTime, calcDragTime, parseAudioIndex } from '../../core/utils/player.utils';
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

  readonly formatTime = formatTime;

  progressPercent(): number {
    return ((this.cast.currentTime() / (this.cast.duration() || 1)) * 100);
  }

  dragPercent(): number {
    return ((this.dragTime() / (this.cast.duration() || 1)) * 100);
  }

  selectSubtitle(sub: any | null) {
    if (!sub) {
      this.cp.activeSubtitleId.set(null);
      this.cast.setActiveSubtitle(0);
      this.cp.changeBurnIn(null);
      this.cp.saveSubtitleSelection(null);
      return;
    }
    this.cp.activeSubtitleId.set(sub.id);
    this.cp.saveSubtitleSelection(sub.language, sub.forced);
    if (sub.burnIn) {
      this.cp.changeBurnIn(sub.castTrackId ?? 0);
    } else if (sub.castTrackId) {
      this.cast.setActiveSubtitle(sub.castTrackId);
    }
  }

  selectAudio(track: any | null) {
    if (!track) return;
    this.cp.activeAudioTrackId.set(track.id);
    this.cp.changeAudio(parseAudioIndex(track.id));
  }

  selectQuality(quality: any) {
    if (quality.id === this.cp.activeQualityId()) return;
    this.cp.changeQuality(quality.id);
  }

  disconnect() {
    this.cast.stop();
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
    this.dragTime.set(calcDragTime(e, bar, this.cast.duration()));
  }
}
