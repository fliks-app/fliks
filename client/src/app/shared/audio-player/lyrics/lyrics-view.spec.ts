import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { LyricsViewComponent } from './lyrics-view';

describe('LyricsViewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks the active line and seeks on click', () => {
    const player = { position: signal(3.2), playing: signal(false), rate: signal(1), seek: vi.fn(async () => {}) };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const doc = { id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 1000, value: 'a' }, { start: 3000, value: 'b' }] } as StructuredLyrics;
    f.componentRef.setInput('doc', doc);
    f.detectChanges();
    const buttons = (f.nativeElement as HTMLElement).querySelectorAll('button');
    expect(buttons[1].getAttribute('aria-current')).toBe('true');
    buttons[0].click();
    expect(player.seek).toHaveBeenCalledWith(1);
  });

  it('shows untimed lines as static text', () => {
    const player = { position: signal(0), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }] });
    const f = TestBed.createComponent(LyricsViewComponent);
    f.componentRef.setInput('doc', { id: 1, kind: 'main', lang: 'und', synced: false, offset: 0, line: [{ value: 'x' }] });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('button')!.disabled).toBe(true);
  });

  it('keeps the text between words', () => {
    const player = { position: signal(0), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const cue = (start: number, end: number, byteStart: number, byteEnd: number, value: string) => ({ start, end, value, byteStart, byteEnd });
    f.componentRef.setInput('doc', {
      id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 0, value: 'la, la' }],
      cueLine: [{ index: 0, start: 0, end: 2000, value: 'la, la', cue: [cue(0, 1000, 0, 2, 'la'), cue(1000, 2000, 4, 6, 'la')] }],
    });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('button')!.textContent!.replace(/\s+/g, ' ')).toContain('lala, lala');
  });
});
