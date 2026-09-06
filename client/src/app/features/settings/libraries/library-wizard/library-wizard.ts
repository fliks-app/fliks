import {
  Component,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideChevronLeft } from '@lucide/angular';
import { UsersApiService, UserRow } from '../../../../core/services/api/users-api.service';
import {
  ProfilesService,
  QualityProfile,
  LanguageProfile,
} from '../../../../core/services/api/profiles.service';
import { ToastService } from '../../../../core/services/toast.service';
import { LibraryDetailState } from '../library-detail/library-detail.state';
import { LibraryFormFieldsComponent } from '../library-detail/library-form-fields/library-form-fields';
import { LibraryUserPickerComponent } from '../library-detail/library-user-picker/library-user-picker';
import { LibraryWizardMediaComponent } from './library-wizard-media';

@Component({
  selector: 'app-library-wizard',
  imports: [
    RouterLink,
    TranslatePipe,
    LucideChevronLeft,
    LibraryFormFieldsComponent,
    LibraryUserPickerComponent,
    LibraryWizardMediaComponent,
  ],
  templateUrl: './library-wizard.html',
  providers: [LibraryDetailState],
})
export class LibraryWizardComponent implements OnInit {
  private readonly usersApi = inject(UsersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly state = inject(LibraryDetailState);

  private readonly mediaStep = viewChild<LibraryWizardMediaComponent>('mediaStep');

  readonly step = signal(1);

  async ngOnInit() {
    const [users, qp, lp] = await Promise.all([
      this.usersApi.list().catch(() => [] as UserRow[]),
      this.profilesApi.getQualityProfiles().catch(() => [] as QualityProfile[]),
      this.profilesApi.getLanguageProfiles().catch(() => [] as LanguageProfile[]),
    ]);
    this.state.users.set(users);
    this.state.qualityProfiles.set(qp);
    this.state.languageProfiles.set(lp);
  }

  next() {
    if (this.step() === 1 && !this.state.validate()) return;
    this.step.update((s) => s + 1);
  }

  back() {
    if (this.step() > 1) this.step.update((s) => s - 1);
  }

  /** Nothing is written before this: the scan of step 3 ran against a bare path. */
  async submit() {
    const media = this.mediaStep();
    if (!media?.scanned()) return;

    const id = await this.state.create();
    if (!id) return;
    // One metadata search per detected folder: the redirect must not wait for
    // it. The library page reports the import over SSE.
    void media
      .importAll(id)
      .then(({ queued, unmatched, failed }) => {
        if (queued > 0) {
          this.toast.success(
            this.translate.instant('settings.libraries.scan_queued', { count: queued }),
          );
        }
        if (unmatched > 0) {
          this.toast.info(
            this.translate.instant('settings.libraries.scan_queued_unmatched', { count: unmatched }),
          );
        }
        if (failed > 0) {
          this.toast.warning(
            this.translate.instant('settings.libraries.scan_search_failed_count', { count: failed }),
          );
        }
      })
      .catch(() => undefined);
    void this.router.navigate(['/admin/settings/libraries', id, 'media']);
  }

  canSubmit(): boolean {
    return !!this.mediaStep()?.scanned() && !this.state.saving();
  }
}
