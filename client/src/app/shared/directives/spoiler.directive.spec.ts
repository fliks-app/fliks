import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SpoilerDirective } from './spoiler.directive';

@Component({
  imports: [SpoilerDirective],
  template: `
    <div (click)="cardClicks.set(cardClicks() + 1)">
      <p [appSpoiler]="active()" [soft]="soft()" #sp="spoiler">secret</p>
    </div>
  `,
})
class HostComponent {
  readonly active = signal(true);
  readonly soft = signal(false);
  readonly cardClicks = signal(0);
}

describe('SpoilerDirective', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const p = fixture.nativeElement.querySelector('p') as HTMLElement;
    return { fixture, p };
  }

  it('blurs while masked and swallows the reveal click', () => {
    const { fixture, p } = setup();
    expect(p.classList).toContain('blur-lg');
    expect(p.getAttribute('role')).toBe('button');

    p.click();
    fixture.detectChanges();

    expect(p.classList).not.toContain('blur-lg');
    // The reveal must not reach the enclosing card's play/open handler.
    expect(fixture.componentInstance.cardClicks()).toBe(0);
  });

  it('lets a click through once revealed', () => {
    const { fixture, p } = setup();
    p.click();
    fixture.detectChanges();
    p.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.cardClicks()).toBe(1);
  });

  it('uses a lighter blur in soft mode', () => {
    const { fixture, p } = setup();
    fixture.componentInstance.soft.set(true);
    fixture.detectChanges();
    expect(p.classList).toContain('blur-sm');
    expect(p.classList).not.toContain('blur-lg');
  });

  it('renders untouched when the account has the feature off', () => {
    const { fixture, p } = setup();
    fixture.componentInstance.active.set(false);
    fixture.detectChanges();
    expect(p.classList).not.toContain('blur-lg');
    expect(p.getAttribute('tabindex')).toBeNull();
  });
});
