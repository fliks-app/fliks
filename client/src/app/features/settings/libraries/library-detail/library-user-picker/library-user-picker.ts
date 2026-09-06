import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LibraryDetailState } from '../library-detail.state';

@Component({
  selector: 'app-library-user-picker',
  imports: [TranslatePipe],
  templateUrl: './library-user-picker.html',
  host: { class: 'flex flex-col gap-5' },
})
export class LibraryUserPickerComponent {
  readonly state = inject(LibraryDetailState);
}
