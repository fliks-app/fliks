import { TestBed } from '@angular/core/testing';
import { PublicProfile, SocialApiService } from '../../core/services/api/social-api.service';
import { ProfileContextService } from './profile-context.service';

describe('ProfileContextService', () => {
  it('ignores the answer of a profile the page has since left', async () => {
    const answers = new Map<number, (p: PublicProfile) => void>();
    TestBed.configureTestingModule({
      providers: [
        ProfileContextService,
        { provide: SocialApiService, useValue: { getProfile: (id: number) => new Promise((r) => answers.set(id, r)) } },
      ],
    });
    const ctx = TestBed.inject(ProfileContextService);
    const first = ctx.load(1);
    const second = ctx.load(2);
    answers.get(2)!({ id: 2 } as PublicProfile);
    await second;
    answers.get(1)!({ id: 1 } as PublicProfile);
    await first;
    expect(ctx.profile()?.id).toBe(2);
    expect(ctx.loading()).toBe(false);
  });

  it('keeps the loading state while the answer of the earlier profile lands', async () => {
    const answers = new Map<number, (p: PublicProfile) => void>();
    TestBed.configureTestingModule({
      providers: [
        ProfileContextService,
        { provide: SocialApiService, useValue: { getProfile: (id: number) => new Promise((r) => answers.set(id, r)) } },
      ],
    });
    const ctx = TestBed.inject(ProfileContextService);
    const first = ctx.load(1);
    void ctx.load(2);
    answers.get(1)!({ id: 1 } as PublicProfile);
    await first;
    expect(ctx.profile()).toBeNull();
    expect(ctx.loading()).toBe(true);
  });
});
