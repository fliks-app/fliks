import {
  Component,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
  PersonsApiService,
  PersonDetail,
} from '../../core/services/api/persons-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { LucideChevronLeft } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { ClampToggleDirective } from '../../shared/directives/clamp-toggle.directive';
import { PersonBooksComponent } from './person-books';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

@Component({
  selector: 'app-person-detail',
  imports: [
    CachedSrcDirective, PersonBooksComponent, TranslatePipe, RouterLink, RouterLinkActive, RouterOutlet, ResolveUrlPipe, ClampToggleDirective, LucideChevronLeft],
  templateUrl: './person-detail.html',
})
export class PersonDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly personsApi = inject(PersonsApiService);
  private readonly navbar = inject(NavbarService);

  readonly detail = signal<PersonDetail | null>(null);
  readonly loading = signal(true);
  readonly id = Number(this.route.snapshot.paramMap.get('id'));
  /** `?role=author|narrator` opens the book view of the person. */
  readonly bookRole = (['author', 'narrator'] as const).find(
    (r) => r === this.route.snapshot.queryParamMap.get('role'),
  );

  ngOnInit() {
    this.load(this.id);
  }

  goBack() {
    this.navbar.goBack(['/persons']);
  }

  private async load(id: number) {
    this.loading.set(true);
    try {
      const detail = await this.personsApi.getOne(id);
      this.detail.set(detail);
    } finally {
      this.loading.set(false);
    }
  }
}
