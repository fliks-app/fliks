import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { HeroProgressComponent } from './hero-progress';

function render(inputs: Record<string, unknown>): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
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
});
