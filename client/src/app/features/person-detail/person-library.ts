import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { PersonDetailComponent } from './person-detail';
import { MediaLinkPipe } from '../../core/pipes/media-link.pipe';

@Component({
  selector: 'app-person-library',
  imports: [MediaLinkPipe, TranslatePipe, MediaCardComponent],
  templateUrl: './person-library.html',
})
export class PersonLibraryComponent {
  readonly parent = inject(PersonDetailComponent);
}
