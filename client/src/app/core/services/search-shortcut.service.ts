import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { isTypingTarget } from '../utils/typing-target';
import { SearchStateService } from './search-state.service';
import { TvService } from './tv.service';

/** `/` and Ctrl/Cmd+K open the search page with its field focused; on admin routes the sidebar filter owns `/`. */
@Injectable({ providedIn: 'root' })
export class SearchShortcutService {
  private readonly router = inject(Router);
  private readonly searchState = inject(SearchStateService);
  private readonly tv = inject(TvService);

  constructor() {
    document.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || this.tv.isTv()) return;
    const palette = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!palette && !slash) return;
    if (!palette && (isTypingTarget(e.target) || this.router.url.startsWith('/admin'))) return;
    e.preventDefault();
    if (this.router.url.split('?')[0] === '/search') this.searchState.requestFocus();
    else void this.router.navigate(['/search']).then(() => this.searchState.requestFocus());
  }
}
