import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import type { LibraryFolderChoice } from '../../../core/services/api/libraries-api.service';
import { formatBytes } from '../../../core/utils/format-bytes';
import { TvSelectDirective } from '../../directives/tv-select.directive';

/** Folder of the chosen library: absent when there is nothing to choose, the first one being the library's default. */
export const defaultFolderId = (folders: LibraryFolderChoice[] | undefined): number | null =>
  folders && folders.length > 1 ? folders[0].id : null;

@Component({
  selector: 'app-library-folder-select',
  imports: [FormsModule, TranslatePipe, TvSelectDirective],
  templateUrl: './library-folder-select.html',
})
export class LibraryFolderSelectComponent {
  readonly folders = input<LibraryFolderChoice[]>([]);
  readonly folderId = model<number | null>(null);
  protected readonly formatBytes = formatBytes;
}
