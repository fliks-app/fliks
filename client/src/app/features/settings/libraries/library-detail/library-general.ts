import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LibraryDetailState } from './library-detail.state';
import { LibraryFormFieldsComponent } from './library-form-fields/library-form-fields';

@Component({
  selector: 'app-library-general',
  imports: [TranslatePipe, LibraryFormFieldsComponent],
  templateUrl: './library-general.html',
})
export class LibraryGeneralComponent {
  readonly state = inject(LibraryDetailState);

  save() {
    void this.state.save();
  }
}
