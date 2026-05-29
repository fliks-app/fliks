import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList,
  CdkDrag,
  CdkDragHandle,
  CdkDragDrop,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import {
  LucideGripVertical,
  LucideArrowUp,
  LucideArrowDown,
} from '@lucide/angular';
import {
  HomeSettingsService,
  ResolvedHomeSection,
  RecentlyAddedMode,
} from '../../../core/services/home-settings.service';
import { LibrariesApiService } from '../../../core/services/api/libraries-api.service';
import { TvService } from '../../../core/services/tv.service';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';

@Component({
  selector: 'app-home-settings',
  imports: [
    TranslateModule,
    FormsModule,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    LucideGripVertical,
    LucideArrowUp,
    LucideArrowDown,
    SelectFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home-settings.html',
})
export class HomeSettingsPageComponent implements OnInit {
  private readonly home = inject(HomeSettingsService);
  private readonly librariesApi = inject(LibrariesApiService);
  readonly tv = inject(TvService);

  /** The rendered, reorderable rows — the working copy persisted on change. */
  readonly rows = signal<ResolvedHomeSection[]>([]);
  readonly mode = signal<RecentlyAddedMode>('media');

  private readonly BUILTIN_LABELS: Record<string, string> = {
    libraries: 'home_settings.section.libraries',
    'continue-watching': 'home_settings.section.continue_watching',
    recommendations: 'home_settings.section.recommendations',
    'recently-added': 'home_settings.section.recently_added',
    'coming-soon': 'home_settings.section.coming_soon',
  };

  async ngOnInit() {
    this.mode.set(this.home.settings().recentlyAddedMode);
    let libs: { id: number; name: string }[] = [];
    try {
      libs = (await this.librariesApi.listMine()).map((l) => ({
        id: l.id,
        name: l.name,
      }));
    } catch {
      /* error handled by global interceptor */
    }
    this.rows.set(this.home.resolve(libs));
  }

  /** Translation key for a built-in zone's label. */
  builtinLabel(section: ResolvedHomeSection): string {
    return this.BUILTIN_LABELS[section.type] ?? section.type;
  }

  private persist() {
    this.home.setOrder(
      this.rows().map((r) => ({ key: r.key, visible: r.visible })),
    );
  }

  drop(event: CdkDragDrop<ResolvedHomeSection[]>) {
    const next = [...this.rows()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    this.rows.set(next);
    this.persist();
  }

  /** Reorder via the arrow buttons (TV remote / keyboard path). */
  move(index: number, delta: number) {
    const next = [...this.rows()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    this.rows.set(next);
    this.persist();
  }

  setVisible(index: number, visible: boolean) {
    const next = [...this.rows()];
    next[index] = { ...next[index], visible };
    this.rows.set(next);
    this.persist();
  }

  onModeChange(mode: RecentlyAddedMode) {
    this.mode.set(mode);
    this.home.setMode(mode);
  }
}
