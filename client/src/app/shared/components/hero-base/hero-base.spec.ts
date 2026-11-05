import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { HeroBaseComponent } from './hero-base';

@Component({
  imports: [HeroBaseComponent],
  template: `
    <app-hero-base [title]="title" [titleLink]="link" [subtitle]="subtitle" mediaType="movie" [posterUrl]="'/p.jpg'" [rating]="7.5" [metaParts]="['1999', '136min']" [chips]="[{ label: 'Movie', cls: 'badge' }]" [overview]="'A story'" [loading]="title === null">
      <p heroMeta id="meta">tagline</p>
      <p heroTags id="tags">genres</p>
      @if (action) { <button heroActions id="act">Add</button> }
      <p heroStatus id="status">note</p>
      <p id="body">facts</p>
    </app-hero-base>`,
})
class HostComponent {
  title: string | null = 'Title';
  link: string[] | null = null;
  subtitle: string | null = null;
  action = true;
}

function render(patch: Partial<HostComponent> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(HostComponent);
  Object.assign(fixture.componentInstance, patch);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HeroBaseComponent', () => {
  it('draws the title, the facts row, the synopsis and the slots, the buttons in their own row', () => {
    const el = render({ subtitle: 'Original' });
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.textContent).toContain('Original');
    expect(el.textContent).toContain('7.5');
    expect(el.textContent).toContain('136min');
    expect(el.querySelector('.badge')?.textContent).toBe('Movie');
    expect(el.textContent).toContain('A story');
    for (const id of ['meta', 'tags', 'status', 'body']) expect(el.querySelector('#' + id)).not.toBeNull();
    expect(el.querySelector('[data-hero-actions] #act')).not.toBeNull();
  });

  it('links the title when given a route', () => {
    const el = render({ link: ['/series', '5'] });
    expect(el.querySelector('h1 a')?.getAttribute('href')).toBe('/series/5');
  });

  it('draws a skeleton title until the title is known', () => {
    const el = render({ title: null });
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('collapses the button row when the page puts nothing in it', () => {
    const el = render({ action: false });
    const row = el.querySelector('[data-hero-actions]')!;
    expect(row.classList.contains('empty:hidden')).toBe(true);
    expect(row.querySelector('button')).toBeNull();
  });
});
