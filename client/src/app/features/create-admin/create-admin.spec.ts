import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { CreateAdminComponent } from './create-admin';

function setup() {
  const auth = { createFirstAdmin: vi.fn(async () => {}) };
  const router = { navigate: vi.fn(async () => true) };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
    ],
  });
  return { cmp: TestBed.createComponent(CreateAdminComponent).componentInstance, auth };
}

describe('CreateAdminComponent', () => {
  it('flags passwords that differ and refuses to submit them', async () => {
    const { cmp, auth } = setup();
    cmp.form.setValue({ username: 'admin', password: 'correct horse', confirm: 'correct hors' });

    expect(cmp.form.hasError('mismatch')).toBe(true);
    await cmp.onSubmit();

    expect(auth.createFirstAdmin).not.toHaveBeenCalled();
  });

  it('creates the account once the passwords match', async () => {
    const { cmp, auth } = setup();
    cmp.form.setValue({ username: ' admin ', password: 'correct horse', confirm: 'correct horse' });

    expect(cmp.form.hasError('mismatch')).toBe(false);
    await cmp.onSubmit();

    expect(auth.createFirstAdmin).toHaveBeenCalledWith('admin', 'correct horse');
  });
});
