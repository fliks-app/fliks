import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { SetupChecklistApiService, type ChecklistItem } from '../../../core/services/api/setup-checklist-api.service';
import { TvService } from '../../../core/services/tv.service';
import { bookSpecProviders } from '../../../features/media-detail/book/book-test-setup';
import { SetupChecklistComponent } from './setup-checklist';

const item = (key: string): ChecklistItem => ({ key, severity: 'recommended', done: false, dismissed: false, route: ['/x'] });

describe('SetupChecklistComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(isAdmin: boolean) {
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: AuthService, useValue: { user: signal({ isAdmin }) } },
        { provide: TvService, useValue: { isTv: signal(false) } },
        {
          provide: SetupChecklistApiService,
          useValue: {
            items: signal([item('download-provider'), item('subtitle-provider')]),
            loading: signal(false),
            refresh: async () => {},
          },
        },
      ),
    });
    const fixture = TestBed.createComponent(SetupChecklistComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('hides the admin-only catalogue step from a user who is not an admin', () => {
    expect(render(false).querySelectorAll('li')).toHaveLength(1);
  });

  it('shows every step to an admin', () => {
    expect(render(true).querySelectorAll('li')).toHaveLength(2);
  });
});
