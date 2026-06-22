import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { LucideChevronLeft } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LibrariesApiService } from '../../../../core/services/api/libraries-api.service';
import { UsersApiService, UserRow } from '../../../../core/services/api/users-api.service';
import {
  ProfilesService,
  QualityProfile,
  LanguageProfile,
} from '../../../../core/services/api/profiles.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { LibraryDetailState } from './library-detail.state';

@Component({
  selector: 'app-library-detail',
  imports: [LucideChevronLeft, TranslateModule, RouterLink, RouterLinkActive, RouterOutlet],
  providers: [LibraryDetailState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-detail.html',
})
export class LibraryDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(LibrariesApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly state = inject(LibraryDetailState);

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(id) || id < 1) {
      this.state.library.set(null);
      return;
    }
    this.state.libraryId.set(id);

    try {
      const [lib, users, qp, lp] = await Promise.all([
        this.api.get(id),
        this.usersApi.list().catch(() => [] as UserRow[]),
        this.profilesApi.getQualityProfiles().catch(() => [] as QualityProfile[]),
        this.profilesApi.getLanguageProfiles().catch(() => [] as LanguageProfile[]),
      ]);
      this.state.users.set(users);
      this.state.qualityProfiles.set(qp);
      this.state.languageProfiles.set(lp);
      this.state.hydrate(lib);
    } catch {
      this.state.library.set(null);
    }
  }

  async remove() {
    const lib = this.state.library();
    if (!lib) return;
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.libraries.confirm_delete', { name: lib.name }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.remove(lib.id);
      void this.router.navigate(['/admin/settings/libraries']);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? 'Error',
        variant: 'danger',
      });
    }
  }
}
