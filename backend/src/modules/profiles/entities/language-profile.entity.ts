import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('language_profiles')
export class LanguageProfile extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'jsonb', default: [] })
  audioLanguages: AudioLanguageItem[];

  @Column({ type: 'jsonb', default: [] })
  subtitleLanguages: SubtitleLanguageItem[];
}

export interface AudioLanguageItem {
  isoCode: string;
  name: string;
}

export type HearingImpairedMode = 'prefer' | 'avoid' | 'require' | 'forbid';

export interface SubtitleLanguageItem {
  isoCode: string;
  name: string;
  forced: boolean;
  hi: boolean;
  /**
   * Per-language hearing-impaired preference. Optional — when absent
   * the legacy `hi` boolean is interpreted: `hi=true` → `prefer`,
   * `hi=false` → `avoid`.
   *
   * - `prefer`:  HI subs score the 1-point bit; non-HI don't.
   * - `avoid`:   non-HI subs score the bit; HI don't. (Default.)
   * - `require`: HI candidates only; non-HI filtered out before scoring.
   * - `forbid`:  non-HI only; HI candidates filtered out.
   */
  hearingImpaired?: HearingImpairedMode;
}

/** Resolves a language item's effective HI mode, defaulting from the
 *  legacy `hi` boolean when no explicit mode is set. */
export function resolveHearingImpairedMode(
  item: SubtitleLanguageItem,
): HearingImpairedMode {
  return item.hearingImpaired ?? (item.hi ? 'prefer' : 'avoid');
}
