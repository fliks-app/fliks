import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmptyStateComponent } from './empty-state';

@Component({
  imports: [EmptyStateComponent],
  template: `<app-empty-state icon="film" title="Nothing here" hint="Add a folder"><button>Go</button></app-empty-state>`,
})
class HostComponent {}

describe('EmptyStateComponent', () => {
  it('renders its title, hint and projected action', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('Nothing here');
    expect(el.querySelector('p')?.textContent).toContain('Add a folder');
    expect(el.querySelector('button')?.textContent).toBe('Go');
  });

  it('omits the hint when none is given', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(EmptyStateComponent);
    fixture.componentRef.setInput('title', 'Empty');
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('p')).toBeNull();
  });
});
