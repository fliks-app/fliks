import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideChevronDown,
  LucideMinus,
  LucidePlus,
  LucideRotateCcw,
  LucideX,
} from '@lucide/angular';
import {
  FONT_SIZE_RANGE,
  FONT_STACKS,
  LINE_HEIGHT_RANGE,
  READER_COLUMNS,
  READER_DEFAULTS,
  READER_FONTS,
  READER_MARGINS,
  READER_THEMES,
  THEME_PRESETS,
  presetPatch,
  resetPatch,
  type ReaderSettings,
} from './reader-settings.service';
import { COMIC_MODES, type ComicPrefs } from './comic-layout';
import type { AppearanceSection } from './reader-features';

/** The Aa panel, with the sections the format offers: a card under the top bar on a wide screen, a bottom sheet on a
 *  phone with the extras folded away. */
@Component({
  selector: 'app-reader-appearance',
  imports: [TranslatePipe, LucideChevronDown, LucideMinus, LucidePlus, LucideRotateCcw, LucideX],
  templateUrl: './reader-appearance.html',
  styleUrl: './reader-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReaderAppearanceComponent {
  readonly sections = input.required<readonly AppearanceSection[]>();
  readonly settings = input.required<ReaderSettings>();
  readonly comic = input<ComicPrefs | null>(null);
  readonly changed = output<Partial<ReaderSettings>>();
  readonly comicChanged = output<ComicPrefs>();
  readonly closed = output<void>();

  protected readonly more = signal(false);
  protected readonly comicModes = COMIC_MODES;
  protected readonly has = (section: AppearanceSection) => this.sections().includes(section);
  protected readonly range = FONT_SIZE_RANGE;
  protected readonly lineRange = LINE_HEIGHT_RANGE;
  protected readonly fonts = READER_FONTS;
  protected readonly margins = READER_MARGINS;
  protected readonly columns = READER_COLUMNS;
  protected readonly presets = READER_THEMES.map((theme) => ({ theme, ...THEME_PRESETS[theme] }));
  protected readonly stacks = FONT_STACKS;
  protected readonly canShrink = computed(
    () => this.settings().fontSize > FONT_SIZE_RANGE.min + 1e-6,
  );
  protected readonly canGrow = computed(
    () => this.settings().fontSize < FONT_SIZE_RANGE.max - 1e-6,
  );

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => host.nativeElement.querySelector<HTMLElement>('[aria-pressed=true]')?.focus());
  }

  protected pick(theme: ReaderSettings['theme']): void {
    this.changed.emit(presetPatch(theme));
  }

  protected step(delta: number): void {
    this.changed.emit({ fontSize: Math.round((this.settings().fontSize + delta) * 10) / 10 });
  }

  protected reset(): void {
    this.changed.emit(resetPatch(this.settings().theme));
  }

  protected numberOf(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }
}
