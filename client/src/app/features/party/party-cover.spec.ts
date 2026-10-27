import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { PartyCover, PartyItem } from '../../core/services/api/party-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';
import { PartyCoverComponent } from './party-cover';

const item = (mediaId: number, episodeId: number | null = null) =>
  ({ mediaId, episodeId, posterUrl: `/p${mediaId}`, stillUrl: `/s${mediaId}`, fanartUrl: null }) as PartyItem;

function render(cover: PartyCover, head: PartyItem | null = null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ServerConfigService, useValue: { isNative: false, resolveUrl: (u: string) => u } },
      { provide: AuthService, useValue: { playbackToken: null } },
    ],
  });
  const fixture = TestBed.createComponent(PartyCoverComponent);
  fixture.componentRef.setInput('cover', cover);
  fixture.componentRef.setInput('head', head);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelectorAll('img');
}

describe('PartyCoverComponent', () => {
  it('shows the uploaded image', () => {
    const imgs = render({ kind: 'upload', url: '/api/parties/1/cover' }, item(1));
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/api/parties/1/cover');
  });

  it('shows the chosen film poster, the chosen episode still', () => {
    expect(render({ kind: 'item', item: item(2) }, item(1))[0].getAttribute('src')).toBe('/p2');
    TestBed.resetTestingModule();
    expect(render({ kind: 'item', item: item(2, 20) })[0].getAttribute('src')).toBe('/s2');
  });

  it('lays a mosaic out as a grid', () => {
    const imgs = render({ kind: 'mosaic', items: [item(1), item(2), item(3), item(4)] });
    expect([...imgs].map((i) => i.getAttribute('src'))).toEqual(['/p1', '/p2', '/p3', '/p4']);
  });

  it('falls back to the programme head when automatic', () => {
    expect(render(null, item(5))[0].getAttribute('src')).toBe('/p5');
    TestBed.resetTestingModule();
    expect(render(null)).toHaveLength(0);
  });
});
