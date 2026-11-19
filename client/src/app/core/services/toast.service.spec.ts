import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ToastService } from './toast.service';

describe('ToastService.notify', () => {
  const base = { title: 'T', body: 'B', actions: [{ label: 'Open', run: () => {} }] };

  it('replaces the toast with the same tag', () => {
    const toast = TestBed.inject(ToastService);
    toast.notify({ ...base, tag: 'episodes:1', tv: false });
    toast.notify({ ...base, body: 'B2', tag: 'episodes:1', tv: false });
    expect(toast.toasts().map((t) => t.message)).toEqual(['B2']);
  });

  it('drops the buttons on a TV', () => {
    const toast = TestBed.inject(ToastService);
    toast.notify({ ...base, tv: true });
    expect(toast.toasts()[0].actions).toEqual([]);
  });
});
