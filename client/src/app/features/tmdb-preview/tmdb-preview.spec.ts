import { Component, inject, input, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService } from '../../core/services/background.service';
import { NavbarService } from '../../core/services/navbar.service';
import { PREVIEW_HOST, type PreviewSeed } from './preview-host';
import { TmdbPreviewComponent } from './tmdb-preview';

@Component({ selector: 'app-stub-body', template: '' })
class StubBody {
  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);
  readonly host = inject(PREVIEW_HOST);
}

function create(params: Record<string, string>) {
  const navbar = { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn() };
  const background = { set: vi.fn(), release: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { kind: 'movie', page: StubBody }, paramMap: { get: (k: string) => params[k] ?? null } } } },
      { provide: NavbarService, useValue: navbar },
      { provide: BackgroundService, useValue: background },
    ],
  });
  const fixture = TestBed.createComponent(TmdbPreviewComponent);
  fixture.detectChanges();
  return { fixture, navbar, background };
}

describe('TmdbPreviewComponent shell', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    history.replaceState({}, '');
  });

  it('hands the body the route and the card seed, and names the navbar after the seed on the first frame', () => {
    history.replaceState({ preview: { externalId: '5', title: 'Seeded', posterUrl: '/p.jpg' } }, '');
    const { fixture, navbar } = create({ tmdbId: '5' });
    const body = fixture.debugElement.query((d) => d.componentInstance instanceof StubBody).componentInstance as StubBody;
    expect(body.provider()).toBe('tmdb');
    expect(body.externalId()).toBe('5');
    expect(body.seed()?.title).toBe('Seeded');
    expect(navbar.enterHeroPage).toHaveBeenCalledWith('Seeded');
  });

  it('ignores a seed that belongs to another title', () => {
    history.replaceState({ preview: { externalId: '9', title: 'Other', posterUrl: null } }, '');
    const { fixture } = create({ provider: 'tvdb', externalId: '5' });
    const body = fixture.debugElement.query((d) => d.componentInstance instanceof StubBody).componentInstance as StubBody;
    expect(body.provider()).toBe('tvdb');
    expect(body.seed()).toBeNull();
  });

  it('lets the body name the navbar and set the backdrop, and hands both back when the page goes', () => {
    const { fixture, navbar, background } = create({ tmdbId: '5' });
    const body = fixture.debugElement.query((d) => d.componentInstance instanceof StubBody).componentInstance as StubBody;
    body.host.setTitle('Loaded', '/logo.png');
    body.host.setBackground('/fanart.jpg', { blur: true });
    expect(navbar.enterHeroPage).toHaveBeenCalledWith('Loaded', '/logo.png');
    expect(background.set).toHaveBeenCalledWith(expect.anything(), '/fanart.jpg', { blur: true });

    fixture.destroy();
    expect(background.release).toHaveBeenCalled();
    expect(navbar.leaveHeroPage).toHaveBeenCalled();
  });
});
