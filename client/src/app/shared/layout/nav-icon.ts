import { Component, input } from '@angular/core';
import {
  LucideHome,
  LucideSearch,
  LucideUserRound,
  LucideListVideo,
  LucideDownload,
  LucideHistory,
  LucideClipboardList,
  LucideCalendar,
  LucideTv,
  LucideCircle,
  LucideLibrary,
  LucideTarget,
} from '@lucide/angular';

/** Renders a nav contribution's icon by name; a plugin can name any string, so unknown names fall back to a generic circle. */
@Component({
  selector: 'app-nav-icon',
  imports: [
    LucideHome, LucideSearch, LucideUserRound, LucideListVideo,
    LucideDownload, LucideHistory, LucideClipboardList, LucideCalendar, LucideTv, LucideCircle,
    LucideLibrary, LucideTarget,
  ],
  templateUrl: './nav-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class NavIconComponent {
  readonly name = input.required<string>();
}
