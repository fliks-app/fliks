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
   * Explicit per-language override, layered on top of the compact `hi`
   * boolean every stored item carries: `hi=true` → `prefer`, `hi=false`
   * → `avoid` when this field is absent.
   *
   * - `prefer`:  HI subs score the 1-point bit; non-HI don't.
   * - `avoid`:   non-HI subs score the bit; HI don't. (Default.)
   * - `require`: HI candidates only; non-HI filtered out before scoring.
   * - `forbid`:  non-HI only; HI candidates filtered out.
   */
  hearingImpaired?: HearingImpairedMode;
}

/** Resolves a language item's effective HI mode from the compact `hi`
 *  boolean — every stored item carries `hi`, not `hearingImpaired`. */
export function resolveHearingImpairedMode(
  item: SubtitleLanguageItem,
): HearingImpairedMode {
  return item.hearingImpaired ?? (item.hi ? 'prefer' : 'avoid');
}
