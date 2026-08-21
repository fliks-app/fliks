import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LibraryDetailState } from './library-detail.state';
import { LibraryUserPickerComponent } from './library-user-picker/library-user-picker';

@Component({
  selector: 'app-library-users',
  imports: [TranslateModule, LibraryUserPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-users.html',
})
export class LibraryUsersComponent {
  readonly state = inject(LibraryDetailState);

  save() {
    void this.state.save();
  }
}
