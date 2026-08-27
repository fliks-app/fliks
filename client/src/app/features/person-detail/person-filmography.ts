import { Component, ChangeDetectionStrategy, signal, inject, OnInit } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFilm } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import {
  PersonsApiService,
  PersonProviderCredits,
} from '../../core/services/api/persons-api.service';
import { PersonDetailComponent } from './person-detail';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

@Component({
  selector: 'app-person-filmography',
  imports: [
    CachedSrcDirective,TranslateModule, SlicePipe, ResolveUrlPipe, LucideFilm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './person-filmography.html',
})
export class PersonFilmographyComponent implements OnInit {
  private readonly parent = inject(PersonDetailComponent);
  private readonly personsApi = inject(PersonsApiService);

  readonly credits = signal<PersonProviderCredits | null>(null);
  readonly loading = signal(true);

  ngOnInit() {
    this.load();
  }

  private async load() {
    const detail = this.parent.detail();
    if (!detail) return;
    this.loading.set(true);
    try {
      const credits = await this.personsApi.getProviderCredits(detail.person.id);
      this.credits.set(credits);
    } finally {
      this.loading.set(false);
    }
  }
}
