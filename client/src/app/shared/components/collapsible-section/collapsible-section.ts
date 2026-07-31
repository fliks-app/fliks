import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  input,
  signal,
} from '@angular/core';
import { LucideChevronDown } from '@lucide/angular';

const LS_PREFIX = 'fliks.section.';
/** Slightly past the fold transition below, so the clip outlives the motion. */
const UNCLIP_DELAY_MS = 250;

export function readSectionOpen(key: string, fallback: boolean): boolean {
  if (!key || typeof localStorage === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(LS_PREFIX + key);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

export function writeSectionOpen(key: string, open: boolean): void {
  if (!key || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_PREFIX + key, open ? '1' : '0');
  } catch {
    // Private browsing / quota: the fold still works, it just won't stick.
  }
}

/**
 * Section with a fold/unfold header that animates to the content's height.
 * Pass a `persistKey` to remember the open state across pages and reloads.
 *
 * Usage: <app-collapsible-section [heading]="'file_info.title' | translate" persistKey="fileInfo">
 */
@Component({
  selector: 'app-collapsible-section',
  imports: [LucideChevronDown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './collapsible-section.html',
  host: { class: 'block' },
})
export class CollapsibleSectionComponent implements OnInit, OnDestroy {
  readonly heading = input.required<string>();
  /** localStorage suffix. Empty means the section reopens at its default. */
  readonly persistKey = input('');
  readonly defaultOpen = input(true);

  protected readonly open = signal(false);
  /** Clipped only while folding: open, a card rail must bleed out its focus ring. */
  protected readonly clipped = signal(true);
  private unclipTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    const open = readSectionOpen(this.persistKey(), this.defaultOpen());
    this.open.set(open);
    this.clipped.set(!open);
  }

  protected toggle() {
    const open = !this.open();
    this.open.set(open);
    writeSectionOpen(this.persistKey(), open);

    if (this.unclipTimer) clearTimeout(this.unclipTimer);
    if (!open) {
      this.clipped.set(true);
      return;
    }
    // Timer, not `transitionend`: Tizen snaps open without firing it.
    this.unclipTimer = setTimeout(() => this.clipped.set(false), UNCLIP_DELAY_MS);
  }

  ngOnDestroy() {
    if (this.unclipTimer) clearTimeout(this.unclipTimer);
  }
}
