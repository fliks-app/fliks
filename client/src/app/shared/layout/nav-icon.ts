import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import {
  LucideHome,
  LucideSearch,
  LucideUserRound,
  LucideListVideo,
  LucideDownload,
  LucideHistory,
  LucideClipboardList,
  LucideCalendar,
  LucideCircle,
} from '@lucide/angular';

/**
 * Renders a nav contribution's icon by name. A plugin can name any string —
 * unrecognised names fall back to a generic circle, never a blank space.
 */
@Component({
  selector: 'app-nav-icon',
  standalone: true,
  imports: [
    LucideHome, LucideSearch, LucideUserRound, LucideListVideo,
    LucideDownload, LucideHistory, LucideClipboardList, LucideCalendar, LucideCircle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './nav-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class NavIconComponent {
  readonly name = input.required<string>();
}
