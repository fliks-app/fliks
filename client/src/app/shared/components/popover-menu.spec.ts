import { Component, ElementRef, provideZonelessChangeDetection, signal, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PopoverMenuComponent } from './popover-menu';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';

/** A trigger whose box the test moves under the open menu, the way a scrolling form does. */
@Component({
  imports: [PopoverMenuComponent],
  template: `
    <button #trigger type="button">open</button>
    <app-popover-menu [open]="open()" [anchor]="anchorEl()">
      <button type="button" class="dropdown-item">an item</button>
    </app-popover-menu>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly trigger = viewChild.required<ElementRef<HTMLElement>>('trigger');
  anchorEl(): HTMLElement {
    return this.trigger().nativeElement;
  }
}

function rectAt(top: number): DOMRect {
  return { top, bottom: top + 32, left: 40, right: 240, width: 200, height: 32, x: 40, y: top, toJSON: () => ({}) } as DOMRect;
}

async function settle(fixture: ComponentFixture<unknown>) {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

/** Drives the component's own `requestAnimationFrame` follow loop one turn. */
async function nextFrames(fixture: ComponentFixture<unknown>, turns = 2) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await settle(fixture);
  }
}

describe('PopoverMenuComponent: following its anchor', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // Desktop with a mouse is the anchored-dropdown branch; touch and TV get a sheet, which
        // has no position to follow.
        { provide: DeviceService, useValue: { isTouch: () => false, isDesktop: () => true } },
        { provide: TvService, useValue: { isTv: () => false } },
        { provide: DismissableStackService, useValue: { push: () => {}, remove: () => {} } },
      ],
    });
    fixture = TestBed.createComponent(HostComponent);
    await settle(fixture);
  });

  /** The popover moves its host out of the fixture, under `<html>`, so it can escape any
   *  scrolling or stacking ancestor. */
  function panel(): HTMLElement | null {
    return document.querySelector('[data-tv-modal]') as HTMLElement | null;
  }

  it('VERDICT: repositions when the trigger moves with no scroll or resize event at all', async () => {
    const trigger = fixture.componentInstance.trigger().nativeElement;
    trigger.getBoundingClientRect = () => rectAt(500);

    fixture.componentInstance.open.set(true);
    await settle(fixture);
    const opened = panel();
    expect(opened).not.toBeNull();
    expect(opened!.style.top).toBe('540px');

    // The container behind the menu scrolls: only the trigger's box changes, and nothing
    // dispatches an event the popover listens to.
    trigger.getBoundingClientRect = () => rectAt(120);
    await nextFrames(fixture);

    expect(panel()!.style.top).toBe('160px');
  });

  it('stops following once closed', async () => {
    const trigger = fixture.componentInstance.trigger().nativeElement;
    trigger.getBoundingClientRect = () => rectAt(200);
    fixture.componentInstance.open.set(true);
    await settle(fixture);
    expect(panel()!.style.top).toBe('240px');

    fixture.componentInstance.open.set(false);
    await settle(fixture);
    expect(panel()).toBeNull();

    // Moving the trigger now must not throw or schedule anything: the loop is cancelled.
    trigger.getBoundingClientRect = () => rectAt(600);
    await nextFrames(fixture);
    expect(panel()).toBeNull();
  });
});
