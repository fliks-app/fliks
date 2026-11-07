import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideChevronLeft } from '@lucide/angular';
import { OptimizeService } from '../../../../core/services/api/optimize.service';
import { LibrariesApiService, Library } from '../../../../core/services/api/libraries-api.service';
import { MediaService, type MediaFileInfo } from '../../../../core/services/api/media.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  Change,
  TrackKind,
  FileOutcome,
  FormatChoice,
  PresetKey,
  ProfileDocument,
  Warning,
  applyFormatChoice,
  formatChoice,
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
const GROUPS = ['video', 'audio', 'subtitles', 'file'] as const;
type Group = (typeof GROUPS)[number];

interface Line {
  group: Group;
  key: string;
  params: Record<string, unknown>;
}

interface SampleOption {
  fileId: number;
  title: string;
  info: MediaFileInfo | null;
}

/** Position of an ffprobe stream among the tracks of its kind, counted from 1 (the absolute index counts the video too). */
type Ordinal = (kind: TrackKind, streamIndex: number) => number | string;

function lineOf(c: Change, track: Ordinal): Line {
  const k = (t: string) => `settings.optimize.change.${t}`;
  switch (c.type) {
    case 'reencode':
      return {
        group: 'video',
        key: k(c.cropOnly ? 'reencode_crop' : 'reencode'),
        params: { codec: c.codec.toUpperCase(), depth: c.bitDepth, height: c.maxHeight ?? '' },
      };
    case 'drop':
      return {
        group: c.kind === 'audio' ? 'audio' : 'subtitles',
        key: k(`drop_${c.reason}`),
        params: { n: track(c.kind, c.streamIndex), language: c.language ?? '?' },
      };
    case 'ocr':
      return { group: 'subtitles', key: k('ocr'), params: { n: track('subtitle', c.streamIndex) } };
    case 'addAudio':
      return { group: 'audio', key: k('add_audio'), params: { n: track('audio', c.sourceStream) } };
    case 'reorder':
      return { group: c.kind === 'audio' ? 'audio' : 'subtitles', key: k('reorder'), params: {} };
    case 'default':
      return { group: 'audio', key: k('default'), params: { n: track('audio', c.streamIndex) } };
    case 'language':
      return {
        group: c.kind === 'audio' ? 'audio' : 'subtitles',
        key: k('language'),
        params: { n: track(c.kind, c.streamIndex), code: c.code },
      };
    case 'flags':
      return {
        group: c.kind === 'audio' ? 'audio' : 'subtitles',
        key: k('flags'),
        params: { n: track(c.kind, c.streamIndex) },
      };
    case 'title':
      return {
        group: c.kind === 'audio' ? 'audio' : 'subtitles',
        key: k('title'),
        params: { n: track(c.kind, c.streamIndex) },
      };
    case 'statisticsTags':
      return { group: 'file', key: k('statistics_tags'), params: {} };
    case 'hvc1':
      return { group: 'file', key: k('hvc1'), params: {} };
    case 'container':
      return { group: 'file', key: k('container'), params: { to: c.to.toUpperCase() } };
    case 'rename':
      return { group: 'file', key: k('rename'), params: {} };
  }
}

@Component({
  selector: 'app-optimize-profile-editor',
  imports: [
    FormsModule,
    RouterLink,
    TranslatePipe,
    LucideChevronLeft,
    ToggleFieldComponent,
    SelectFieldComponent,
    InputFieldComponent,
    MultiSelectComponent,
    OrderedListComponent,
  ],
  templateUrl: './profile-editor.html',
})
export class OptimizeProfileEditorComponent implements OnInit {
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
  readonly sampleFiles = signal<SampleOption[]>([]);
  readonly sampleFileId = signal<number | null>(null);
  readonly outcome = signal<FileOutcome | null>(null);
  readonly outcomeError = signal(false);
  readonly outcomeBusy = signal(false);
  private previewSeq = 0;
  private libSeq = 0;

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
    const info = this.sampleFiles().find((f) => f.fileId === this.sampleFileId())?.info;
    const track: Ordinal = (kind, streamIndex) => {
      const list = kind === 'audio' ? info?.audio : info?.subtitles;
      const pos = list?.findIndex((t) => t.streamIndex === streamIndex) ?? -1;
      return pos >= 0 ? pos + 1 : '?';
    };
    const all = o?.status === 'diff' ? o.changes.map((c) => lineOf(c, track)) : [];
    return GROUPS.map((g) => ({ group: g, items: all.filter((l) => l.group === g) })).filter(
      (g) => g.items.length > 0,
    );
  });
  readonly warnings = computed<Warning[]>(() => {
    const o = this.outcome();
    return o && (o.status === 'diff' || o.status === 'conform') ? o.warnings : [];
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
    this.sampleFileId.set(null);
    this.outcome.set(null);
    try {
      const page = await this.media.getAll({
        libraryId: id, limit: 100, sortBy: 'title', sortOrder: 'ASC', view: 'grid',
      });
      if (seq !== this.libSeq) return;
      const files = page.data.flatMap((m) =>
        m.files?.[0] ? [{ fileId: m.files[0].id, title: m.title, info: m.files[0].streamInfo ?? null }] : [],
      );
      this.sampleFiles.set(files);
      this.sampleFileId.set(files[0]?.fileId ?? null);
    } catch {
      if (seq === this.libSeq) this.sampleFiles.set([]);
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
