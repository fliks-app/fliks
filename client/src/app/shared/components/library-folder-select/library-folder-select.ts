import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import type { LibraryFolderChoice } from '../../../core/services/api/libraries-api.service';
import { formatBytes } from '../../../core/utils/format-bytes';
import { TvSelectDirective } from '../../directives/tv-select.directive';

/** A choice, with the free space only a manager screen knows. */
export type LibraryFolderOption = LibraryFolderChoice & { freeSpace?: number | null };

/** Folder of the chosen library: absent when there is nothing to choose, the first one being the library's default. */
export const defaultFolderId = (folders: LibraryFolderOption[] | undefined): number | null =>
  folders && folders.length > 1 ? folders[0].id : null;

@Component({
  selector: 'app-library-folder-select',
  imports: [FormsModule, TranslatePipe, TvSelectDirective],
  templateUrl: './library-folder-select.html',
  host: { '[class.hidden]': 'folders().length < 2' },
})
export class LibraryFolderSelectComponent {
  readonly folders = input<LibraryFolderOption[]>([]);
  readonly folderId = model<number | null>(null);
  protected readonly formatBytes = formatBytes;
}
