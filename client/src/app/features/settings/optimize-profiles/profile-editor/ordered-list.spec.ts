import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { OrderedListComponent } from './ordered-list';

function make(value: string[]) {
  TestBed.configureTestingModule({ providers: [provideTranslateService()] });
  const f = TestBed.createComponent(OrderedListComponent);
  f.componentRef.setInput('options', [
    { value: 'fra', label: 'French' },
    { value: 'eng', label: 'English' },
    { value: 'jpn', label: 'Japanese' },
  ]);
  f.componentRef.setInput('value', value);
  return f.componentInstance;
}

describe('OrderedListComponent', () => {
  it('keeps the saved order, not an alphabetical one', () => {
    expect(
      make(['jpn', 'fra'])
        .rows()
        .map((r) => r.label),
    ).toEqual(['Japanese', 'French']);
  });

  it('moves a row, ignores a move past the ends, and lists only what is left to add', () => {
    const c = make(['fra', 'eng']);
    c.move(1, -1);
    expect(c.value()).toEqual(['eng', 'fra']);
    c.move(0, -1);
    expect(c.value()).toEqual(['eng', 'fra']);
    expect(c.rest().map((o) => o.value)).toEqual(['jpn']);
    c.add('jpn');
    c.remove(0);
    expect(c.value()).toEqual(['fra', 'jpn']);
  });
});
