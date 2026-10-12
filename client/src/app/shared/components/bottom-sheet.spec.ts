import { describe, expect, it } from 'vitest';
import { scrolledBetween } from './bottom-sheet';

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
