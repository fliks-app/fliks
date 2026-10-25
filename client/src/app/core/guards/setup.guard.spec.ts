import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { setupGuard } from './setup.guard';
import { AuthService } from '../services/auth.service';

async function run(required: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthService, useValue: { setupRequired: async () => required } },
    ],
  });
  return TestBed.runInInjectionContext(() => setupGuard({} as never, {} as never));
}

describe('setupGuard', () => {
  it('sends a server with no account to the first-admin page', async () => {
    const res = await run(true);
    expect(res instanceof UrlTree && res.toString()).toBe('/create-admin');
  });

  it('lets an installed server through', async () => {
    expect(await run(false)).toBe(true);
  });
});
