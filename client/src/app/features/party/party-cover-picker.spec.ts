import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { ServerConfigService } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';
import { AUTO_COVER, PartyCoverPickerComponent, coverChange, coverChoice, coverValid, draftFromCover, type CoverOption } from './party-cover-picker';

const options: CoverOption[] = [1, 2, 3, 4, 5].map((id) => ({ mediaId: id, episodeId: null, title: `T${id}`, posterUrl: `/p${id}` }));

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService(),
      { provide: ServerConfigService, useValue: { isNative: false, resolveUrl: (u: string) => u } },
      { provide: AuthService, useValue: { playbackToken: null } },
    ],
  });
  const fixture = TestBed.createComponent(PartyCoverPickerComponent);
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('draft', AUTO_COVER);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const draft = () => (fixture.componentInstance as unknown as { draft(): typeof AUTO_COVER }).draft();
  const mode = (i: number) => (el.querySelectorAll('[role=radio]')[i] as HTMLButtonElement).click();
  const thumb = (i: number) => (el.querySelectorAll('[aria-pressed]')[i] as HTMLButtonElement).click();
  const flush = () => fixture.detectChanges();
  return { el, draft, mode, thumb, flush };
}

describe('PartyCoverPickerComponent', () => {
  it('switches mode and shows the thumbs only to pick items', () => {
    const t = setup();
    expect(t.el.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    t.mode(1);
    t.flush();
    expect(t.draft().mode).toBe('item');
    expect(t.el.querySelectorAll('[aria-pressed]')).toHaveLength(5);
    t.mode(3);
    t.flush();
    expect(t.el.querySelector('input[type=file]')).not.toBeNull();
  });

  it('keeps a single pick for one item', () => {
    const t = setup();
    t.mode(1);
    t.flush();
    t.thumb(0);
    t.thumb(2);
    expect(t.draft().picked).toEqual([{ mediaId: 3 }]);
  });

  it('caps a mosaic at four and toggles a pick off', () => {
    const t = setup();
    t.mode(2);
    t.flush();
    for (let i = 0; i < 5; i++) t.thumb(i);
    expect(t.draft().picked.map((p) => p.mediaId)).toEqual([1, 2, 3, 4]);
    t.thumb(0);
    expect(t.draft().picked.map((p) => p.mediaId)).toEqual([2, 3, 4]);
  });
});

describe('cover draft', () => {
  const item = { mediaId: 1, episodeId: null } as never;
  it('is valid when complete', () => {
    expect(coverValid({ mode: 'mosaic', picked: [{ mediaId: 1 }], file: null })).toBe(false);
    expect(coverValid({ mode: 'mosaic', picked: [{ mediaId: 1 }, { mediaId: 2 }], file: null })).toBe(true);
    expect(coverValid({ mode: 'upload', picked: [], file: null })).toBe(false);
    expect(coverChoice({ mode: 'item', picked: [{ mediaId: 1, episodeId: 3 }], file: null })).toEqual({ kind: 'item', mediaId: 1, episodeId: 3 });
  });

  it('diffs against the current cover', () => {
    const was = { kind: 'item', item } as const;
    expect(coverChange(was, draftFromCover(was))).toEqual({});
    expect(coverChange(was, AUTO_COVER)).toEqual({ patch: null });
    expect(coverChange({ kind: 'upload', url: '/u' }, AUTO_COVER)).toEqual({ remove: true });
    expect(coverChange(null, { mode: 'item', picked: [{ mediaId: 2 }], file: null })).toEqual({ patch: { kind: 'item', mediaId: 2 } });
    const file = new File(['x'], 'c.png');
    expect(coverChange(was, { mode: 'upload', picked: [], file })).toEqual({ upload: file });
  });
});
