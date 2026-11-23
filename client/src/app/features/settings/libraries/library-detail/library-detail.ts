import { Component, computed, inject, OnInit } from '@angular/core';
import { SERVER_SINCE, ServerVersionService } from '../../../../core/services/server-version.service';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../../shared/icons';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LibrariesApiService } from '../../../../core/services/api/libraries-api.service';
import { UsersApiService, UserRow } from '../../../../core/services/api/users-api.service';
import {
  ProfilesService,
  QualityProfile,
  LanguageProfile,
} from '../../../../core/services/api/profiles.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { LibraryDetailState } from './library-detail.state';
import { ImportProgressBannerComponent } from '../../../../shared/components/import-progress-banner/import-progress-banner';

@Component({
  selector: 'app-library-detail',
  imports: [
    TranslatePipe,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    ImportProgressBannerComponent, LucideDynamicIcon,
  ],
  providers: [LibraryDetailState],
  templateUrl: './library-detail.html',
})
export class LibraryDetailComponent implements OnInit {
  protected readonly icons = icons;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(LibrariesApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly state = inject(LibraryDetailState);
  private readonly versions = inject(ServerVersionService);
  readonly optimize = computed(() => this.versions.supports(SERVER_SINCE.optimize));

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(id) || id < 1) {
      this.state.library.set(null);
      this.state.loading.set(false);
      return;
    }
    this.state.libraryId.set(id);

    // Options only feed the tab selects — the page renders without them.
    const options = Promise.all([
      this.usersApi.list().catch(() => [] as UserRow[]),
      this.profilesApi.getQualityProfiles().catch(() => [] as QualityProfile[]),
      this.profilesApi.getLanguageProfiles().catch(() => [] as LanguageProfile[]),
    ]);

    try {
      this.state.hydrate(await this.api.get(id));
    } catch {
      this.state.library.set(null);
    } finally {
      this.state.loading.set(false);
    }

    const [users, qp, lp] = await options;
    this.state.users.set(users);
    this.state.qualityProfiles.set(qp);
    this.state.languageProfiles.set(lp);
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
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
        variant: 'danger',
      });
    }
  }
}
