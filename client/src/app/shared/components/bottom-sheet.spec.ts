import { Component, ElementRef, provideZonelessChangeDetection, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheetComponent, scrolledBetween } from './bottom-sheet';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { TvService } from '../../core/services/tv.service';

function sheetWithList() {
  const sheet = document.createElement('div');
  const list = document.createElement('div');
  const row = document.createElement('button');
  list.appendChild(row);
  sheet.appendChild(list);
  return { sheet, list, row };
}

describe('scrolledBetween', () => {
  it('is false when neither the sheet nor an inner list is scrolled', () => {
    const { sheet, row } = sheetWithList();
    expect(scrolledBetween(row, sheet)).toBe(false);
  });

  it('sees an inner list scrolled down while the sheet itself is at its top', () => {
    const { sheet, list, row } = sheetWithList();
    Object.defineProperty(list, 'scrollTop', { value: 120 });
    expect(scrolledBetween(row, sheet)).toBe(true);
  });

  it('ignores scrolled containers outside the sheet', () => {
    const { sheet, row } = sheetWithList();
    const page = document.createElement('div');
    page.appendChild(sheet);
    Object.defineProperty(page, 'scrollTop', { value: 500 });
    expect(scrolledBetween(row, sheet)).toBe(false);
  });
});

@Component({
  imports: [BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()">
      <div #list style="overflow-y: auto">
        <button #row type="button" aria-current="true">current</button>
      </div>
    </app-bottom-sheet>
  `,
})
class SheetHost {
  readonly open = signal(false);
  readonly list = viewChild.required<ElementRef<HTMLElement>>('list');
  readonly row = viewChild.required<ElementRef<HTMLElement>>('row');
  readonly sheet = viewChild.required(BottomSheetComponent);
}

describe('BottomSheetComponent: scroll to the current choice', () => {
  it('scrolls the list to the selected row on open without moving focus', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TvService, useValue: { isTv: () => false } },
        { provide: DismissableStackService, useValue: { push: () => {}, remove: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(SheetHost);
    fixture.detectChanges();
    const list = fixture.componentInstance.list().nativeElement;
    const row = fixture.componentInstance.row().nativeElement;
    const box = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
    Object.defineProperties(list, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 } });
    list.getBoundingClientRect = () => box(100, 300);
    row.getBoundingClientRect = () => box(700, 40);
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo;

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(scrollTo).toHaveBeenCalledWith({ top: 470, behavior: 'instant' });
    expect(document.activeElement).not.toBe(row);
  });
});

describe('BottomSheetComponent: drag from the handle', () => {
  it('drags the sheet down from the title even when its list is scrolled', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TvService, useValue: { isTv: () => false } },
        { provide: DismissableStackService, useValue: { push: () => {}, remove: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(SheetHost);
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const sheet = fixture.componentInstance.sheet();
    const el = sheet.sheet()!.nativeElement;
    Object.defineProperty(el, 'scrollTop', { value: 200 });
    const handle = el.querySelector('[data-sheet-handle]')!;
    const touch = (y: number) => ({ target: handle, touches: [{ clientY: y }], preventDefault: () => {} }) as unknown as TouchEvent;

    sheet.onTouchStart(touch(100));
    sheet.onTouchMove(touch(160));

    expect(sheet.dragOffset()).toBe(60);
  });
});
