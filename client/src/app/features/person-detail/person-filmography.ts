import { Component, signal, inject, OnInit } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  PersonsApiService,
  PersonProviderCredits,
  PersonProviderCreditItem,
} from '../../core/services/api/persons-api.service';
import { PersonDetailComponent } from './person-detail';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';

@Component({
  selector: 'app-person-filmography',
  imports: [TranslatePipe, MediaCardComponent],
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

  /** Role first, release year when the provider gives none. */
  subtitleFor(credit: PersonProviderCreditItem): string | undefined {
    return (
      credit.character || credit.job || credit.releaseDate?.slice(0, 4) || undefined
    );
  }

  /** Owned works open in the library; the rest land on the provider preview
   *  page, where they can be requested. */
  linkFor(credit: PersonProviderCreditItem): string[] {
    const series = credit.mediaType === 'series';
    if (credit.mediaId) {
      return [series ? '/series' : '/movies', String(credit.mediaId)];
    }
    return [
      series ? '/add/tv' : '/add/movie',
      this.credits()?.provider ?? 'tmdb',
      String(credit.externalId),
    ];
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
