import { Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePlus, LucideTrash2 } from '@lucide/angular';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { Playlist, PlaylistsApiService } from '../../../core/services/api/playlists-api.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  CRITERION_FIELDS, CRITERION_TYPES, RELEASE_TYPES, SORT_BY, cleanRules, createPreviewer, criterionValid, defaultRules,
  newCriterion, rulesValid, type Criterion, type CriterionType, type Field, type PreviewState, type SmartRules, type SortBy,
} from '../../../core/services/api/smart-rules';

type Bag = Record<string, unknown>;

/** Dialog to create a smart playlist (no `playlist`) or edit the rules of one. */
@Component({
  selector: 'app-smart-playlist-editor',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, ModalHeaderComponent, ModalFooterComponent, LucidePlus, LucideTrash2],
  templateUrl: './smart-playlist-editor.html',
})
export class SmartPlaylistEditorComponent {
  private readonly api = inject(PlaylistsApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly playlist = input<Playlist | null>(null);
  readonly saved = output<Playlist>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly types = CRITERION_TYPES;
  protected readonly sorts = SORT_BY;
  protected readonly releaseTypes = RELEASE_TYPES;
  protected readonly fields = CRITERION_FIELDS;
  protected readonly name = signal('');
  protected readonly rules = signal<SmartRules>(defaultRules());
  protected readonly preview = signal<PreviewState>({ status: 'idle', count: null });
  protected readonly libraries = signal<LibrarySummary[]>([]);
  protected readonly busy = signal(false);

  private readonly previewer = createPreviewer(
    (r) => this.api.preview(r),
    (s) => this.preview.set(s),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.previewer.cancel());
  }

  open(): void {
    const p = this.playlist();
    this.name.set('');
    this.setRules(p?.rules ? structuredClone(p.rules) : defaultRules());
    this.dialog().nativeElement.showModal();
    void this.librariesApi
      .listMine()
      .then((l) => this.libraries.set(l.filter((x) => x.mediaTypes.includes('album'))))
      .catch(() => undefined);
  }

  protected close(): void {
    this.previewer.cancel();
    this.dialog().nativeElement.close();
  }

  protected valid(): boolean {
    return rulesValid(this.rules()) && (!!this.playlist() || !!this.name().trim());
  }

  protected rowValid(c: Criterion): boolean {
    return criterionValid(c);
  }

  private setRules(r: SmartRules): void {
    this.rules.set(r);
    this.previewer.request(r);
  }

  protected patch(p: Partial<SmartRules>): void {
    this.setRules({ ...this.rules(), ...p });
  }

  protected setSort(by: SortBy, descending: boolean): void {
    this.patch({ sort: { by, descending } });
  }

  protected setLimit(raw: string): void {
    this.patch({ limit: raw === '' ? null : Number(raw) });
  }

  protected addRule(): void {
    this.patch({ criteria: [...this.rules().criteria, newCriterion('artist')] });
  }

  protected removeRule(i: number): void {
    this.patch({ criteria: this.rules().criteria.filter((_, j) => j !== i) });
  }

  protected setType(i: number, type: CriterionType): void {
    this.replace(i, newCriterion(type));
  }

  private replace(i: number, c: Criterion): void {
    this.patch({ criteria: this.rules().criteria.map((x, j) => (j === i ? c : x)) });
  }

  protected value(c: Criterion, key: string): unknown {
    return (c as unknown as Bag)[key];
  }

  protected setField(i: number, key: string, value: unknown): void {
    this.replace(i, { ...this.rules().criteria[i], [key]: value } as Criterion);
  }

  protected setNumber(i: number, f: Field, raw: string): void {
    this.setField(i, f.key, raw === '' ? undefined : Number(raw));
  }

  protected has(c: Criterion, key: string, item: string | number): boolean {
    return (this.value(c, key) as (string | number)[]).includes(item);
  }

  protected toggle(i: number, key: string, item: string | number): void {
    const cur = this.value(this.rules().criteria[i], key) as (string | number)[];
    this.setField(i, key, cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item]);
  }

  protected codecsText(c: Criterion): string {
    return ((this.value(c, 'codecs') as string[]) ?? []).join(', ');
  }

  protected setCodecs(i: number, raw: string): void {
    this.setField(i, 'codecs', raw.split(',').map((s) => s.trim()).filter(Boolean));
  }

  protected async save(): Promise<void> {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    try {
      const rules = cleanRules(this.rules());
      const p = this.playlist();
      const result = p ? await this.api.update(p.id, { rules }) : await this.api.create({ name: this.name().trim(), rules });
      this.toast.success(this.translate.instant('playlists.saved'));
      this.close();
      this.saved.emit(result);
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busy.set(false);
    }
  }
}
