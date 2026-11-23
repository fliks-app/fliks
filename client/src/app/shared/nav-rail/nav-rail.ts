import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { LucideDynamicIcon } from '@lucide/angular';
import { libraryColorVar, libraryIcon, libraryUrl } from '../../core/constants/library-appearance';
import { NavContributionsService, type ResolvedNavItem } from '../../core/plugin-ui/nav-contributions.service';
import type { LibrarySummary } from '../../core/services/api/libraries-api.service';
import { BackgroundService } from '../../core/services/background.service';
import { NavbarService } from '../../core/services/navbar.service';
import { NetworkService } from '../../core/services/network.service';
import { TvService } from '../../core/services/tv.service';
import { icons } from '../icons';
import { LucideIconComponent } from '../components/lucide-icon';
import { PopoverMenuComponent } from '../components/popover-menu';
import { UserMenuComponent } from '../components/user-menu';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvSectionDirective } from '../directives/tv-section.directive';
import { NavIconComponent } from '../layout/nav-icon';
import { keyboardModality } from '../../core/services/focusable.constants';

/** Libraries listed in the rail before "Plus" takes the rest. */
const RAIL_LIBRARIES = 3;

/** The one navigation list: a left column on desktop, tablet and TV (collapsed to icons, opening on focus or hover, or
 *  expanded when pinned) and the content of the drawer on phones. Entries come from the nav contributions and the libraries. */
@Component({
  selector: 'app-nav-rail',
  imports: [
    NgTemplateOutlet, RouterLink, RouterLinkActive, TranslatePipe,
    LucideDynamicIcon,
    LucideIconComponent, NavIconComponent, PopoverMenuComponent, UserMenuComponent, TvRowDirective, TvSectionDirective,
  ],
  host: { class: 'block h-full' },
  templateUrl: './nav-rail.html',
})
export class NavRailComponent {
  /** `collapsed` shows icons and opens as an overlay; `expanded` is always open (pinned column, drawer). */
  readonly mode = input.required<'collapsed' | 'expanded'>();
  readonly libraries = input.required<readonly LibrarySummary[]>();
  readonly librariesLoaded = input(true);
  readonly libraryCounts = input<Record<number, number>>({});
  readonly badgeCounts = input<Record<string, number>>({});

  /** True while the collapsed rail is open over the page, which the layout dims. */
  readonly overlaying = output<boolean>();

  protected readonly icons = icons;
  protected readonly background = inject(BackgroundService);
  protected readonly navbar = inject(NavbarService);
  protected readonly network = inject(NetworkService);
  protected readonly tv = inject(TvService);
  private readonly router = inject(Router);
  private readonly contrib = inject(NavContributionsService);

  protected readonly before = this.contrib.mainItemsBeforeLibraries;
  protected readonly after = this.contrib.mainItemsAfterLibraries;
  protected readonly acquisition = this.contrib.acquisitionItems;

  protected readonly shown = computed(() => this.libraries().slice(0, RAIL_LIBRARIES));
  protected readonly more = computed(() => this.libraries().length > RAIL_LIBRARIES);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** The current page is a library the rail only lists under "Plus". */
  protected readonly plusCurrent = computed(() =>
    this.libraries().slice(RAIL_LIBRARIES).some((l) => this.isCurrent(l)),
  );

  protected readonly plusOpen = signal(false);
  private readonly hovered = signal(false);
  private readonly focused = signal(false);
  /** Labels show when pinned or in the drawer, while hovered or focused, and while "Plus" is open beside the rail. */
  protected readonly open = computed(
    () => this.mode() === 'expanded' || this.hovered() || this.focused() || this.plusOpen(),
  );

  private readonly overlayingEffect = effect(() => this.overlaying.emit(this.mode() === 'collapsed' && this.open()));

  protected readonly libraryUrl = libraryUrl;
  protected readonly libraryIcon = libraryIcon;
  protected readonly libraryColor = (lib: LibrarySummary) => libraryColorVar(lib.color);

  private isCurrent(lib: LibrarySummary): boolean {
    const path = this.url().split(/[?#]/)[0];
    const base = libraryUrl(lib);
    return path === base || path.startsWith(`${base}/`);
  }

  protected badgeCountFor(item: ResolvedNavItem): number {
    return (item.badgeKey && this.badgeCounts()[item.badgeKey]) || 0;
  }

  /** Focus opens the rail when it came from the keyboard or D-pad: a mouse click leaves focus behind on a link. */
  protected onFocusIn(e: FocusEvent): void {
    if (keyboardModality()) this.focused.set(true);
  }

  protected onFocusOut(e: FocusEvent, host: HTMLElement): void {
    if (!host.contains(e.relatedTarget as Node | null)) this.focused.set(false);
  }

  /** Hover opens it for a mouse only: touch emulates it on tap. */
  protected onPointer(e: PointerEvent, over: boolean): void {
    if (e.pointerType === 'mouse') this.hovered.set(over);
  }
}
