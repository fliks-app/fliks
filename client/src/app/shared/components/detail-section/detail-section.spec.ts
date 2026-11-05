import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DetailSectionComponent } from './detail-section';

@Component({
  imports: [DetailSectionComponent],
  template: `<app-detail-section [heading]="heading" [collapsible]="collapsible"><p id="body">body</p></app-detail-section>`,
})
class HostComponent {
  heading: string | null = 'Cast';
  collapsible = true;
}

function render(patch: Partial<HostComponent> = {}) {
  const fixture = TestBed.createComponent(HostComponent);
  Object.assign(fixture.componentInstance, patch);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('DetailSectionComponent', () => {
  it('draws a divider, then a folding heading over the content', () => {
    const el = render();
    expect(el.querySelector('.divider')).not.toBeNull();
    expect(el.querySelector('button')?.textContent).toContain('Cast');
    expect(el.querySelector('#body')).not.toBeNull();
  });

  it('keeps a plain heading with no fold when not collapsible', () => {
    const el = render({ collapsible: false });
    expect(el.querySelector('h2')?.textContent).toContain('Cast');
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector('#body')).not.toBeNull();
  });

  it('draws only the divider and the content without a heading', () => {
    const el = render({ heading: null });
    expect(el.querySelector('h2, button')).toBeNull();
    expect(el.querySelector('#body')).not.toBeNull();
  });

});
