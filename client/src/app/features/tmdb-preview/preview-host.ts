import { InjectionToken } from '@angular/core';

/** What the card that opened the page already knows, handed over in router state. */
export interface PreviewSeed {
  externalId: string;
  title: string;
  posterUrl: string | null;
  fanartUrl?: string | null;
}

/** The shell around a kind's preview body: the hero chrome, which the shell hands back when the page goes. */
export interface PreviewHost {
  /** Names the navbar after the title once it is known. */
  setTitle(title: string, logoUrl?: string | null): void;
  setBackground(url: string | null, opts?: { blur?: boolean }): void;
}

export const PREVIEW_HOST = new InjectionToken<PreviewHost>('PREVIEW_HOST');
