import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
  ViewChild,
  ElementRef,
  AfterViewInit,
} from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  PersonsApiService,
  PersonDetail,
} from '../../core/services/api/persons-api.service';
import { LucideChevronLeft } from '@lucide/angular';

@Component({
  selector: 'app-person-detail',
  imports: [TranslateModule, RouterLink, RouterLinkActive, RouterOutlet, LucideChevronLeft],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './person-detail.html',
})
export class PersonDetailComponent implements OnInit, AfterViewInit {
  private readonly route = inject(ActivatedRoute);
  private readonly personsApi = inject(PersonsApiService);

  @ViewChild('bioText') bioTextRef?: ElementRef<HTMLParagraphElement>;

  readonly detail = signal<PersonDetail | null>(null);
  readonly loading = signal(true);
  readonly bioClamped = signal(false);
  readonly bioExpanded = signal(false);

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.load(id);
  }

  ngAfterViewInit() {
    this.checkBioClamped();
  }

  private checkBioClamped() {
    requestAnimationFrame(() => {
      const el = this.bioTextRef?.nativeElement;
      if (el) {
        this.bioClamped.set(el.scrollHeight > el.clientHeight);
      }
    });
  }

  toggleBio() {
    this.bioExpanded.update((v) => !v);
  }

  private async load(id: number) {
    this.loading.set(true);
    try {
      const detail = await this.personsApi.getOne(id);
      this.detail.set(detail);
    } finally {
      this.loading.set(false);
      this.checkBioClamped();
    }
  }
}
