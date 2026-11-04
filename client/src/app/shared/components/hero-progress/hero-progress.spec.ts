import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { HeroProgressComponent } from './hero-progress';

function render(inputs: Record<string, unknown>): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(HeroProgressComponent);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HeroProgressComponent', () => {
  it('renders nothing at 0', () => {
    expect(render({ percent: 0 }).querySelector('[role=progressbar]')).toBeNull();
  });

  it('fills the bar and shows the caption', () => {
    const el = render({ percent: 40, label: '12min left' });
    expect(el.querySelector<HTMLElement>('.bg-primary')?.style.width).toBe('40%');
    expect(el.textContent).toContain('12min left');
  });

  it('keeps the caption without a bar at 0 and 100, and names the bar', () => {
    expect(render({ percent: 100, label: '100% done' }).querySelector('[role=progressbar]')).toBeNull();
    expect(render({ percent: 0, label: '0 of 4 read' }).textContent).toContain('0 of 4 read');
    const bar = render({ percent: 40, label: '12min left' }).querySelector('[role=progressbar]')!;
    expect(bar.getAttribute('aria-valuetext')).toBe('12min left');
    expect(bar.getAttribute('aria-label')).toBeTruthy();
  });
});
