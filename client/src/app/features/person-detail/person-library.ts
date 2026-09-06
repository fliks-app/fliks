import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { PersonDetailComponent } from './person-detail';

@Component({
  selector: 'app-person-library',
  imports: [TranslatePipe, MediaCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './person-library.html',
})
export class PersonLibraryComponent {
  readonly parent = inject(PersonDetailComponent);
}
