import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { HomeComponent } from './home';

describe('HomeComponent new party button', () => {
  it('opens the create dialog with no film', () => {
    const createRequest = signal<unknown>(null);
    (HomeComponent.prototype as unknown as { newParty(this: object): void }).newParty.call({ party: { createRequest } });
    expect(createRequest()).toEqual({ title: '' });
  });
});
