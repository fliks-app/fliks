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
import { PersonHeaderComponent } from '../../shared/components/person-header/person-header';
import { PersonBooksComponent } from './person-books';
import { FollowToggleComponent } from '../../shared/components/follow-toggle/follow-toggle';

@Component({
  selector: 'app-person-detail',
  imports: [
    PersonBooksComponent, PersonHeaderComponent, FollowToggleComponent, TranslatePipe, RouterLink, RouterLinkActive, RouterOutlet, LucideChevronLeft],
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
