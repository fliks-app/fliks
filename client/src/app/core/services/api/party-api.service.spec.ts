import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '@angular/common/http';
import { throwError, of } from 'rxjs';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { ServerVersionService } from '../server-version.service';
import { PartyApiService } from './party-api.service';

function setup(post: unknown) {
  TestBed.configureTestingModule({
    providers: [
      { provide: HttpClient, useValue: { post } },
      { provide: AuthService, useValue: {} },
      { provide: ServerConfigService, useValue: {} },
      { provide: ServerVersionService, useValue: {} },
    ],
  });
  return TestBed.inject(PartyApiService);
}

describe('PartyApiService.decline', () => {
  it('posts to the decline route', async () => {
    const post = vi.fn(() => of(undefined));
    await setup(post).decline(7);
    expect(post).toHaveBeenCalledWith('/api/parties/7/decline', {}, expect.anything());
  });

  it('treats a 404 as already declined', async () => {
    const api = setup(() => throwError(() => new HttpErrorResponse({ status: 404 })));
    await expect(api.decline(7)).resolves.toBeUndefined();
  });

  it('rethrows any other failure', async () => {
    const api = setup(() => throwError(() => new HttpErrorResponse({ status: 500 })));
    await expect(api.decline(7)).rejects.toMatchObject({ status: 500 });
  });
});
