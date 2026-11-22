import { describe, expect, it } from 'vitest';
import { splitYear } from './search-query';

describe('splitYear', () => {
  it('takes a trailing or inner year out of the title', () => {
    expect(splitYear('the matrix 1999')).toEqual({ title: 'the matrix', year: 1999 });
    expect(splitYear('matrix 1999 reloaded')).toEqual({ title: 'matrix reloaded', year: 1999 });
  });

  it('keeps a query that is only a year, and numbers that are not years', () => {
    expect(splitYear('1984')).toEqual({ title: '1984', year: null });
    expect(splitYear('apollo 1887')).toEqual({ title: 'apollo 1887', year: null });
    expect(splitYear('apollo 13')).toEqual({ title: 'apollo 13', year: null });
    expect(splitYear('catch 19999')).toEqual({ title: 'catch 19999', year: null });
  });

  it('takes the last year when there are several', () => {
    expect(splitYear('1984 2009')).toEqual({ title: '1984', year: 2009 });
  });
});
