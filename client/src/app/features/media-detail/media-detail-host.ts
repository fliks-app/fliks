import { InjectionToken, type Signal, type WritableSignal } from '@angular/core';
import type { Media } from '../../core/services/api/media.service';
import type { RequestFlowController } from './request-flow-controller';

/** What a card can hand an episode page before its media request lands. */
export interface HandedEpisode {
  episodeId: number;
  stillUrl: string;
  title: string | null;
  label: string | null;
}

/** The shell around a kind page: the title it loaded, the chrome and the modals every kind shares. */
export interface MediaDetailHost {
  readonly media: WritableSignal<Media | null>;
  /** False while only a list handover is shown. */
  readonly fullLoaded: Signal<boolean>;
  readonly notFound: WritableSignal<boolean>;
  /** Episode data painted from the card handoff while the media request is in flight. */
  readonly episodeSeed: Signal<HandedEpisode | null>;
  /** Navbar title of the page, when it is not the title's own. */
  readonly navTitle: WritableSignal<string | null>;
  /** Bumped each time a cached page comes back on screen. */
  readonly returns: Signal<number>;
  readonly requestFlow: RequestFlowController;
  readonly deleteLoading: Signal<boolean>;
  readonly monitoredLoading: Signal<boolean>;
  /** The `?action=` deep links the page answers itself, over the shell's own. */
  registerPageActions(actions: Record<string, () => void>): void;
  reload(): Promise<void>;
  openProfiles(): void;
  openLibrary(): void;
  openAnalyze(): void;
  openIdentify(): void;
  deleteMedia(): Promise<void>;
  toggleMonitored(): Promise<void>;
  refreshMetadata(): Promise<void>;
}

export const MEDIA_DETAIL_HOST = new InjectionToken<MediaDetailHost>('MEDIA_DETAIL_HOST');
