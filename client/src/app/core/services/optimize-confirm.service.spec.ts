import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { OptimizeService } from './api/optimize.service';
import { ConfirmationService } from './confirmation.service';
import { OptimizeConfirmService } from './optimize-confirm.service';

function setup(optimizeOriginal: string | Error) {
  const confirm = vi.fn().mockResolvedValue(true);
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService({
        loader: {
          provide: TranslateLoader,
          useValue: {
            getTranslation: () =>
              of({
                optimize: { action: { confirm_files: '{{count}} files.', confirm_title: 'Title' } },
                settings: { optimize: { global: { original_delete: 'Deleted.', delete_warning: 'Final.' } } },
              }),
          },
        },
        lang: 'en',
      }),
      {
        provide: OptimizeService,
        useValue: {
          settings: () =>
            optimizeOriginal instanceof Error ? Promise.reject(optimizeOriginal) : Promise.resolve({ optimizeOriginal }),
        },
      },
      { provide: ConfirmationService, useValue: { confirm } },
    ],
  });
  return { svc: TestBed.inject(OptimizeConfirmService), confirm };
}

describe('OptimizeConfirmService', () => {
  it('names the count and warns that a delete policy cannot be undone', async () => {
    const { svc, confirm } = setup('delete');
    expect(await svc.confirmRewrite(12, 'Go')).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: '12 files. Deleted. Final.', variant: 'danger', confirmLabel: 'Go' }),
    );
  });

  it('asks nothing and refuses when the policy cannot be read', async () => {
    const { svc, confirm } = setup(new Error('down'));
    expect(await svc.confirmRewrite(3, 'Go')).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
