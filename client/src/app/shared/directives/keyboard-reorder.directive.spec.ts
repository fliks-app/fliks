import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardReorderDirective } from './keyboard-reorder.directive';

@Component({
  imports: [KeyboardReorderDirective],
  template: `<div [appKeyboardReorder]="items().length" removable (moved)="move($event)" (removed)="remove($event)">
    @for (i of items(); track i) {
      <button data-reorder-item>{{ i }}</button>
    }
  </div>`,
})
class Host {
  readonly items = signal(['a', 'b', 'c']);
  move({ from, to }: { from: number; to: number }) {
    const list = [...this.items()];
    list.splice(to, 0, ...list.splice(from, 1));
    this.items.set(list);
  }
  remove(i: number) {
    this.items.set(this.items().filter((_, k) => k !== i));
  }
}

describe('KeyboardReorderDirective', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    Element.prototype.animate = vi.fn() as unknown as Element['animate'];
  });

  function setup() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(Host);
    document.body.append(f.nativeElement);
    f.detectChanges();
    const press = async (key: string) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      (document.activeElement as HTMLElement).dispatchEvent(e);
      f.detectChanges();
      await f.whenStable();
      return e;
    };
    const buttons = () => Array.from(f.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>);
    return { f, press, buttons };
  }

  it('picks an item up with Enter, moves it with the arrows and drops it with Enter', async () => {
    const { f, press, buttons } = setup();
    buttons()[0].focus();
    expect((await press('Enter')).defaultPrevented).toBe(true);
    await press('ArrowRight');
    await press('ArrowRight');
    expect(f.componentInstance.items()).toEqual(['b', 'c', 'a']);
    await press('Enter');
    expect(buttons().some((b) => b.closest('.reorder-held'))).toBe(false);
    f.nativeElement.remove();
  });

  it('moves left too, and removes the item over the trash', async () => {
    const { f, press, buttons } = setup();
    buttons()[2].focus();
    await press('Enter');
    await press('ArrowLeft');
    expect(f.componentInstance.items()).toEqual(['a', 'c', 'b']);
    await press('Enter');
    buttons()[2].focus();
    await press('Enter');
    await press('ArrowRight');
    await press('Enter');
    expect(f.componentInstance.items()).toEqual(['a', 'c']);
    f.nativeElement.remove();
  });
});
