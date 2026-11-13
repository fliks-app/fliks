import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import type { KaraokeModel, KaraokeModels } from '../../../core/services/api/karaoke.models';
import { SseService } from '../../../core/services/sse.service';
import { KaraokeModelsComponent } from './karaoke-models';

function model(over: Partial<KaraokeModel>): KaraokeModel {
  return {
    id: 'm',
    kind: 'alignment',
    name: 'M',
    version: '1',
    licence: { name: 'Apache-2.0', text: '', clear: true },
    default: false,
    languages: [],
    homepage: '',
    sizeBytes: 1000,
    diskBytes: 0,
    outdated: false,
    state: 'absent',
    downloadedBytes: 0,
    verifying: false,
    ...over,
  };
}

function create(models: KaraokeModel[]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: HttpClient,
        useValue: { get: () => of({ languages: [], tracks: 0, running: false }) },
      },
      { provide: SseService, useValue: { karaokeEvents: new Subject() } },
    ],
  });
  const fixture = TestBed.createComponent(KaraokeModelsComponent);
  const catalogue: KaraokeModels = {
    runtime: { onnx: true, providers: [], whisper: true, rubberband: false },
    modelsDir: '/m',
    usedBytes: 0,
    orphans: [],
    models,
  };
  fixture.componentRef.setInput('catalogue', catalogue);
  fixture.componentRef.setInput('aligners', {});
  fixture.detectChanges();
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return fixture.componentInstance as any;
}

describe('KaraokeModelsComponent', () => {
  it('cancels a download but never a verification', () => {
    const c = create([]);
    expect(c.canCancel(model({ state: 'downloading' }))).toBe(true);
    expect(
      c.canCancel(model({ state: 'downloading', verifying: true, installedVersion: '1' })),
    ).toBe(false);
    expect(c.canCancel(model({ state: 'installed' }))).toBe(false);
  });

  it('puts the speech recogniser in its own group', () => {
    const c = create([
      model({ id: 'sep', kind: 'separation' }),
      model({ id: 'ctc', engine: 'ctc' }),
      model({ id: 'whisper', engine: 'whisper' }),
    ]);
    expect(
      c
        .groups()
        .map((g: { key: string; models: KaraokeModel[] }) => [g.key, g.models.map((m) => m.id)]),
    ).toEqual([
      ['separation', ['sep']],
      ['alignment', ['ctc']],
      ['recognition', ['whisper']],
    ]);
  });

  it('shows a speed only while the engine reports one', () => {
    const c = create([]);
    expect(c.speed(model({ state: 'downloading' }))).toBeNull();
    expect(
      c.speed(model({ state: 'downloading', bytesPerSecond: 1000, downloadedBytes: 500 })),
    ).toContain('/s');
  });

  it('offers an update for an outdated model', () => {
    const c = create([]);
    expect(c.canDownload(model({ state: 'installed', outdated: true }))).toBe(true);
    expect(c.canDownload(model({ state: 'installed' }))).toBe(false);
  });
});
