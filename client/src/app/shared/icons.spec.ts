import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import * as lucide from '@lucide/angular';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from './icons';

@Component({
  selector: 'app-icons-host',
  imports: [LucideDynamicIcon],
  template: `<svg [lucideIcon]="icons.ArrowLeft" class="h-4 w-4" [strokeWidth]="1.5"></svg>`,
})
class HostComponent {
  protected readonly icons = icons;
}

describe('icons registry', () => {
  it('holds named icon data with drawable nodes', () => {
    const entries = Object.entries(icons);
    expect(entries.length).toBeGreaterThan(100);
    for (const [key, data] of entries) {
      expect(data.name, key).toBeTruthy();
      expect(data.node.length, key).toBeGreaterThan(0);
    }
  });

  it('matches the data of the per-icon components of @lucide/angular', () => {
    const components = lucide as unknown as Record<string, { icon: unknown }>;
    for (const [key, data] of Object.entries(icons)) {
      expect(data, key).toEqual(components[`Lucide${key}`].icon);
    }
  });

  it('renders an icon through the generic component with the same svg as the per-icon one', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const svg: SVGElement = fixture.nativeElement.querySelector('svg');
    expect(svg.classList.contains('lucide-arrow-left')).toBe(true);
    expect(svg.classList.contains('h-4')).toBe(true);
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });
});
