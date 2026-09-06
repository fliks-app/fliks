import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  inject,
  signal,
  viewChild,
  OnInit,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
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
  LucideSettings,
  LucideEye,
  LucideEyeOff,
} from '@lucide/angular';
import {
  HomeSettingsService,
  ResolvedHomeSection,
  RecentlyAddedMode,
} from '../../../core/services/home-settings.service';
import { LibrariesApiService } from '../../../core/services/api/libraries-api.service';
import { LibraryPrefsService } from '../../../core/services/library-prefs.service';
import { TvService } from '../../../core/services/tv.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { DisplaySettingsService } from '../../../core/services/display-settings.service';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

@Component({
  selector: 'app-home-settings',
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    TranslatePipe,
    FormsModule,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    LucideGripVertical,
    LucideArrowUp,
    LucideArrowDown,
    LucideSettings,
    LucideEye,
    LucideEyeOff,
    SelectFieldComponent,
    ToggleFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home-settings.html',
})
export class HomeSettingsPageComponent implements OnInit {
  private readonly home = inject(HomeSettingsService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly libraryPrefs = inject(LibraryPrefsService);
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  readonly tv = inject(TvService);

  /** The rendered, reorderable rows — the working copy persisted on change. */
  readonly rows = signal<ResolvedHomeSection[]>([]);
  readonly mode = signal<RecentlyAddedMode>('media');
  readonly onlyMyRequests = signal(false);

  /** Cached so reset/rebuild can re-resolve without refetching libraries. */
  private libs: { id: number; name: string }[] = [];

  // --- Library order + visibility modal ---
  private readonly libraryDialog = viewChild<ElementRef<HTMLDialogElement>>('libraryDialog');
  /** Working copy edited in the modal: every accessible library in the user's
   *  order, each flagged hidden. Persisted only on save. */
  readonly libraryRows = signal<{ id: number; name: string; hidden: boolean }[]>([]);
  readonly librarySaving = signal(false);

  private readonly BUILTIN_LABELS: Record<string, string> = {
    'received-recommendations': 'home_settings.section.received_recommendations',
    libraries: 'home_settings.section.libraries',
    'continue-watching': 'home_settings.section.continue_watching',
    recommendations: 'home_settings.section.recommendations',
    likes: 'home_settings.section.likes',
    'recently-added': 'home_settings.section.recently_added',
    playlists: 'home_settings.section.playlists',
    'coming-soon': 'home_settings.section.coming_soon',
    'requests-recent': 'home_settings.section.requests_recent',
  };

  async ngOnInit() {
    this.mode.set(this.home.settings().recentlyAddedMode);
    this.onlyMyRequests.set(this.displaySettings.get().onlyMyRequests);
    try {
      this.libs = (await this.librariesApi.listMine()).map((l) => ({
        id: l.id,
        name: l.name,
      }));
    } catch {
      /* error handled by global interceptor */
    }
    this.rebuild();
  }

  private get requestsAllowed(): boolean {
    return this.auth.hasPermission('requests.create') || this.auth.hasPermission('requests.manage');
  }

  /** Re-derive the rendered rows from the persisted settings + current libs. */
  private rebuild() {
    this.rows.set(this.home.resolve(this.libs, { requests: this.requestsAllowed }));
  }

  /** Reset zone order + visibility to defaults, after confirmation. */
  async reset() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('home_settings.reset_confirm_title'),
      message: this.translate.instant('home_settings.reset_confirm'),
      confirmLabel: this.translate.instant('home_settings.reset'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.home.resetLayout();
    this.rebuild();
  }

  /** Translation key for a built-in zone's label. */
  builtinLabel(section: ResolvedHomeSection): string {
    return this.BUILTIN_LABELS[section.type] ?? section.type;
  }

  private persist() {
    this.home.setOrder(this.rows().map((r) => ({ key: r.key, visible: r.visible })));
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

  /** Open the library order + visibility modal, seeded from saved prefs. */
  openLibraryReorder() {
    this.libraryRows.set(this.libraryPrefs.ordered(this.libs));
    this.libraryDialog()?.nativeElement.showModal();
  }

  closeLibraryReorder() {
    this.libraryDialog()?.nativeElement.close();
  }

  dropLibrary(event: CdkDragDrop<unknown[]>) {
    const next = [...this.libraryRows()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    this.libraryRows.set(next);
  }

  /** Reorder via arrows (TV remote / keyboard path). */
  moveLibrary(index: number, delta: number) {
    const next = [...this.libraryRows()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    this.libraryRows.set(next);
  }

  toggleLibraryHidden(index: number) {
    const next = [...this.libraryRows()];
    next[index] = { ...next[index], hidden: !next[index].hidden };
    this.libraryRows.set(next);
  }

  async saveLibraryOrder() {
    this.librarySaving.set(true);
    try {
      const rows = this.libraryRows();
      await this.libraryPrefs.save(
        rows.map((r) => r.id),
        rows.filter((r) => r.hidden).map((r) => r.id),
      );
      this.closeLibraryReorder();
    } catch {
      /* error toast handled by global interceptor */
    } finally {
      this.librarySaving.set(false);
    }
  }

  onModeChange(mode: RecentlyAddedMode) {
    this.mode.set(mode);
    this.home.setMode(mode);
  }

  onOnlyMyRequestsChange(value: boolean) {
    this.onlyMyRequests.set(value);
    this.displaySettings.save({ onlyMyRequests: value });
  }
}
