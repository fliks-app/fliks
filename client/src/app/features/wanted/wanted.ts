import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MEDIA_KINDS, KIND_REGISTRY, mediaDetailLink } from '../../core/media-kinds';
import type { MediaType } from '../../core/enums/media-type.enum';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { WantsApiService, type WantedRow } from '../../core/services/api/wants-api.service';
import { localizeLanguage } from '../../core/utils/language.utils';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

const PAGE = 25;

/** What the library still wants: each unsatisfied want of a monitored title, of any kind. */
@Component({
  selector: 'app-wanted',
  imports: [RouterLink, TranslatePipe, LocaleDatePipe, ResolveUrlPipe, CachedSrcDirective],
  templateUrl: './wanted.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WantedComponent {
  private readonly api = inject(WantsApiService);
  private readonly translate = inject(TranslateService);

  protected readonly kinds = MEDIA_KINDS;
  protected readonly registry = KIND_REGISTRY;
  protected readonly kind = signal<MediaType | null>(null);
  protected readonly released = signal<boolean | null>(null);
  protected readonly rows = signal<WantedRow[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly more = computed(() => this.rows().length < this.total());

  /** A response for an older filter must not land over a newer one. */
  private generation = 0;
  private page = 1;

  constructor() {
    void this.load(false);
  }

  protected link(r: WantedRow) {
    return mediaDetailLink(r.type, r.mediaId);
  }

  protected language(code: string | null) {
    return code ? localizeLanguage(code, this.translate) : null;
  }

  protected setKind(k: MediaType | null) {
    this.kind.set(k);
    void this.load(false);
  }

  protected setReleased(v: boolean | null) {
    this.released.set(v);
    void this.load(false);
  }

  protected loadMore() {
    void this.load(true);
  }

  private async load(append: boolean) {
    const gen = ++this.generation;
    this.loading.set(true);
    this.failed.set(false);
    const page = append ? this.page + 1 : 1;
    const params: Record<string, string | number> = { page, limit: PAGE };
    const kind = this.kind();
    const released = this.released();
    if (kind) params['type'] = kind;
    if (released !== null) params['released'] = String(released);
    try {
      const answer = await this.api.wanted(params);
      if (gen !== this.generation) return;
      this.page = page;
      this.rows.update((r) => (append ? [...r, ...answer.data] : answer.data));
      this.total.set(answer.total);
    } catch {
      if (gen === this.generation) this.failed.set(true);
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }
}
