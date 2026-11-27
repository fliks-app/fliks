import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../../shared/icons';
import { OptimizeService } from '../../../../core/services/api/optimize.service';
import { LibrariesApiService, Library } from '../../../../core/services/api/libraries-api.service';
import { MediaService, type MediaFileInfo } from '../../../../core/services/api/media.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { ToastService } from '../../../../core/services/toast.service';
import { episodeLabel } from '../../../../core/services/download-manager.service';
import {
  FileOutcome,
  FormatChoice,
  PresetKey,
  ProfileDocument,
  applyFormatChoice,
  formatChoice,
  groupedChanges,
  trackOrdinal,
  warningLine,
} from '../../../../core/models/optimize';
import { ToggleFieldComponent } from '../../../../shared/components/forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../../../../shared/components/forms/select-field/select-field';
import { InputFieldComponent } from '../../../../shared/components/forms/input-field/input-field';
import { OrderedListComponent } from './ordered-list';
import {
  MultiSelectComponent,
  MultiSelectOption,
} from '../../../../shared/components/forms/multi-select/multi-select';

const FORMATS: FormatChoice[] = ['most_compact', 'playable_everywhere', 'hevc', 'av1'];
const VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vc1', 'mpeg2', 'mpeg4'];

interface SampleOption {
  fileId: number;
  title: string;
  info: MediaFileInfo | null;
}

interface SampleMedia extends SampleOption {
  mediaId: number;
  series: boolean;
}

@Component({
  selector: 'app-optimize-profile-editor',
  imports: [
    FormsModule,
    RouterLink,
    TranslatePipe,
    ToggleFieldComponent,
    SelectFieldComponent,
    InputFieldComponent,
    MultiSelectComponent,
    OrderedListComponent, LucideDynamicIcon,
  ],
  templateUrl: './profile-editor.html',
})
export class OptimizeProfileEditorComponent implements OnInit {
  protected readonly icons = icons;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(OptimizeService);
  private readonly libraries = inject(LibrariesApiService);
  private readonly media = inject(MediaService);
  private readonly profiles = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly formats = FORMATS;
  readonly videoCodecs = VIDEO_CODECS.map((c) => ({ value: c, label: c.toUpperCase() }));

  readonly id = signal<number | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly name = signal('');
  readonly doc = signal<ProfileDocument | null>(null);
  readonly dropKinds = ['commentary', 'audio_description'].map((v) => ({
    value: v,
    label: this.translate.instant(`settings.optimize.drop_kind.${v}`),
  }));
  readonly languageOptions = signal<MultiSelectOption<string>[]>([]);

  readonly sampleLibraries = signal<Library[]>([]);
  readonly sampleLibraryId = signal<number | null>(null);
  readonly sampleMedia = signal<SampleMedia[]>([]);
  readonly sampleMediaId = signal<number | null>(null);
  readonly sampleEpisodes = signal<SampleOption[]>([]);
  readonly sampleFileId = signal<number | null>(null);
  readonly outcome = signal<FileOutcome | null>(null);
  readonly outcomeError = signal(false);
  readonly outcomeBusy = signal(false);
  private previewSeq = 0;
  private libSeq = 0;
  private mediaSeq = 0;

  readonly format = computed(() => {
    const d = this.doc();
    return d ? formatChoice(d.video) : 'most_compact';
  });
  readonly minBitrateMbps = computed(() => {
    const m = this.doc()?.video.when.min_bitrate;
    return m ? String(m / 1_000_000) : '';
  });

  readonly lines = computed(() => {
    const o = this.outcome();
    const id = this.sampleFileId();
    const info = [...this.sampleEpisodes(), ...this.sampleMedia()].find((f) => f.fileId === id)?.info;
    return o?.status === 'diff' ? groupedChanges(o.changes, trackOrdinal(info)) : [];
  });
  readonly warnings = computed(() => {
    const o = this.outcome();
    return o && (o.status === 'diff' || o.status === 'conform') ? o.warnings.map(warningLine) : [];
  });
  /** A track removal is final once the trash is purged. */
  readonly removesTracks = computed(() => {
    const o = this.outcome();
    return o?.status === 'diff' && o.changes.some((c) => c.type === 'drop');
  });

  constructor() {
    effect((onCleanup) => {
      const d = this.doc();
      const lib = this.sampleLibraryId();
      const file = this.sampleFileId();
      if (!d || !lib || !file) return;
      const t = setTimeout(() => void this.runPreview(lib, file, d), 400);
      onCleanup(() => clearTimeout(t));
    });
  }

  async ngOnInit() {
    const idParam = this.route.snapshot.paramMap.get('id');
    const id = idParam && idParam !== 'new' ? Number(idParam) : null;
    this.id.set(id);
    try {
      const [defs, libs] = await Promise.all([
        this.profiles.getLanguageDefinitions(),
        this.libraries.list(),
      ]);
      this.languageOptions.set([
        { value: 'original', label: this.translate.instant('settings.optimize.lang_original') },
        { value: 'media_profile', label: this.translate.instant('settings.optimize.lang_media_profile') },
        ...defs.map((l) => ({ value: l.isoCode, label: `${l.name} (${l.isoCode})` })),
      ]);
      this.sampleLibraries.set(libs.filter((l) => l.mediaTypes.some((t) => t === 'movie' || t === 'series')));
      if (id == null) {
        const key = (this.route.snapshot.queryParamMap.get('preset') ?? 'balanced') as PresetKey;
        const presets = await this.api.presets();
        const preset = presets.find((p) => p.key === key) ?? presets[0];
        this.doc.set(structuredClone(preset!.document));
        this.name.set(this.translate.instant(`settings.optimize.presets.${preset!.key}.name`));
      } else {
        const p = await this.api.profile(id);
        this.name.set(p.name);
        this.doc.set(structuredClone(p.document));
      }
      const first = this.sampleLibraries()[0];
      if (first) await this.pickLibrary(first.id);
    } catch {
      void this.router.navigate(['/admin/settings/optimize-profiles']);
    } finally {
      this.loading.set(false);
    }
  }

  /** Mutates a copy: signals only notify on a new reference. */
  edit(fn: (d: ProfileDocument) => void) {
    const d = structuredClone(this.doc()!);
    fn(d);
    this.doc.set(d);
  }

  num(v: string, fallback: number, whole = true): number {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? Math.max(0, whole ? Math.round(n) : n) : fallback;
  }

  setFormat(c: string) {
    this.edit((d) => applyFormatChoice(d.video, c as FormatChoice));
  }

  setMinBitrate(v: string) {
    this.edit((d) => {
      const n = this.num(v, 0, false);
      d.video.when.min_bitrate = n > 0 ? Math.round(n * 1_000_000) : null;
    });
  }

  async pickLibrary(id: number) {
    const seq = ++this.libSeq;
    this.sampleLibraryId.set(id);
    this.sampleMediaId.set(null);
    this.sampleEpisodes.set([]);
    this.sampleFileId.set(null);
    this.outcome.set(null);
    try {
      const page = await this.media.getAll({
        libraryId: id, limit: 100, sortBy: 'title', sortOrder: 'ASC',
      });
      if (seq !== this.libSeq) return;
      const media = page.data.flatMap((m) =>
        m.files?.[0]
          ? [{ mediaId: m.id, series: m.type === 'series', fileId: m.files[0].id, title: m.title, info: m.files[0].streamInfo ?? null }]
          : [],
      );
      this.sampleMedia.set(media);
      if (media[0]) await this.pickMedia(media[0].mediaId);
    } catch {
      if (seq === this.libSeq) this.sampleMedia.set([]);
    }
  }

  /** A series previews one episode file, picked in a third select. */
  async pickMedia(id: number) {
    const seq = ++this.mediaSeq;
    const m = this.sampleMedia().find((x) => x.mediaId === id);
    this.sampleMediaId.set(id);
    this.sampleEpisodes.set([]);
    this.sampleFileId.set(m?.fileId ?? null);
    if (!m?.series) return;
    try {
      const detail = await this.media.getOne(id, { silent: true });
      if (seq !== this.mediaSeq) return;
      const byEpisode = new Map((detail.files ?? []).map((f) => [f.episodeId, f]));
      const seen = new Set<number>();
      const episodes = (detail.seasons ?? []).flatMap((s) =>
        s.episodes.flatMap((e) => {
          const f = byEpisode.get(e.id);
          if (!f || seen.has(f.id)) return [];
          seen.add(f.id);
          return [{ fileId: f.id, title: episodeLabel(s.seasonNumber, e.episodeNumber, e.title), info: f.streamInfo ?? null }];
        }),
      );
      this.sampleEpisodes.set(episodes);
      if (episodes[0] && !seen.has(m.fileId)) this.sampleFileId.set(episodes[0].fileId);
    } catch {
      // The series' first file stays the sample.
    }
  }

  private async runPreview(lib: number, file: number, doc: ProfileDocument) {
    const seq = ++this.previewSeq;
    this.outcomeBusy.set(true);
    try {
      const o = await this.api.previewFile(lib, file, doc);
      if (seq !== this.previewSeq) return;
      this.outcome.set(o);
      this.outcomeError.set(false);
    } catch {
      if (seq !== this.previewSeq) return;
      this.outcome.set(null);
      this.outcomeError.set(true);
    } finally {
      if (seq === this.previewSeq) this.outcomeBusy.set(false);
    }
  }

  async save() {
    const doc = this.doc();
    const name = this.name().trim();
    if (!doc || !name) {
      this.toast.error(this.translate.instant('settings.optimize.editor.name_required'));
      return;
    }
    this.saving.set(true);
    try {
      const id = this.id();
      await (id == null
        ? this.api.createProfile({ name, document: doc })
        : this.api.updateProfile(id, { name, document: doc }));
      this.toast.success(this.translate.instant('settings.optimize.editor.saved'));
      void this.router.navigate(['/admin/settings/optimize-profiles']);
    } catch {
      // The global interceptor toasts the server's reasons.
    } finally {
      this.saving.set(false);
    }
  }
}
