import { Component, signal, inject, OnInit } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
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
    CachedSrcDirective,TranslatePipe, SlicePipe, ResolveUrlPipe, LucideFilm],
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
