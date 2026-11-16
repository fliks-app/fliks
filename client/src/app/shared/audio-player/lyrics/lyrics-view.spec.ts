import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
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

  it('lights overlapping lines, marks the singers and fills each line on its own cues', () => {
    const player = { position: signal(2), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }, provideTranslateService()] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const cl = (index: number, start: number, end: number, agentId: string) => ({ index, start, end, value: 'x', agentId, cue: [{ start, end, value: 'x', byteStart: 0, byteEnd: 1 }] });
    f.componentRef.setInput('doc', {
      id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 0, value: 'x' }, { start: 1000, value: 'x' }, { start: 6000, value: 'x' }],
      agents: [{ id: 'v1', role: 'main' }, { id: 'v2', role: 'voice' }],
      cueLine: [cl(0, 0, 4000, 'v1'), cl(1, 1000, 3000, 'v2'), cl(2, 6000, 8000, 'v1')],
    });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-current'))).toEqual(['true', 'true', null]);
    expect([...el.querySelectorAll('[data-testid="lyrics-mark"]')].map((m) => m.textContent)).toEqual(['●', '▲', '●']);
    const clips = [...el.querySelectorAll<HTMLElement>('[data-cue]')].map((e) => e.style.getPropertyValue('clip-path'));
    expect(clips).toEqual(['inset(0px 50% 0px 0px)', 'inset(0px 50% 0px 0px)', 'inset(0px 100% 0px 0px)']);
  });

  it('paints the words being sung without touching the template until a word ends', () => {
    const player = { position: signal(2), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const cl = (index: number, start: number, end: number) => ({ index, start, end, value: 'x', cue: [{ start, end, value: 'x', byteStart: 0, byteEnd: 1 }] });
    f.componentRef.setInput('doc', {
      id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 0, value: 'x' }, { start: 1000, value: 'x' }],
      cueLine: [cl(0, 0, 4000), cl(1, 1000, 3000)],
    });
    f.detectChanges();
    const c = f.componentInstance as unknown as { sync(pos: number): void; clock(): number };
    const clips = () => [...(f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[data-cue]')].map((e) => e.style.getPropertyValue('clip-path'));
    c.sync(2500);
    expect(c.clock()).toBe(2000);
    expect(clips()).toEqual(['inset(0px 37.5% 0px 0px)', 'inset(0px 25% 0px 0px)']);
    c.sync(3500);
    expect(c.clock()).toBe(3500);
    f.detectChanges();
    expect(clips()).toEqual(['inset(0px 12.5% 0px 0px)', 'inset(0px 0% 0px 0px)']);
  });

  it('shows no mark on a duet line nobody tagged, and keeps the text column', () => {
    const player = { position: signal(0), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }, provideTranslateService()] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const cl = (index: number, agentId?: string) => ({ index, start: index * 1000, end: index * 1000 + 900, value: 'x', ...(agentId ? { agentId } : {}), cue: [] });
    f.componentRef.setInput('doc', {
      id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 0, value: 'x' }, { start: 1000, value: 'x' }],
      agents: [{ id: 'v1', role: 'main' }, { id: 'v2', role: 'voice' }],
      cueLine: [cl(0, 'v1'), cl(1)],
    });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('[data-testid="lyrics-mark"]')].map((m) => m.textContent)).toEqual(['●']);
    expect(el.querySelectorAll('button .flex > span[aria-hidden="true"]').length).toBe(2);
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

  it('scrolls back to the top when the document changes', () => {
    const player = { position: signal(0), playing: signal(false), rate: signal(1), seek: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayerService, useValue: player }] });
    const f = TestBed.createComponent(LyricsViewComponent);
    const mk = (id: number) => ({ id, kind: 'main', lang: 'en', synced: true, offset: 0, line: [{ start: 5000, value: 'a' }, { start: 6000, value: 'b' }] }) as StructuredLyrics;
    f.componentRef.setInput('doc', mk(1));
    f.detectChanges();
    const box = (f.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="lyrics-lines"]')!;
    const top = vi.fn();
    Object.defineProperty(box, 'scrollTop', { set: top, get: () => 40 });
    f.componentRef.setInput('doc', mk(2));
    f.detectChanges();
    expect(top).toHaveBeenCalledWith(0);
  });
});
