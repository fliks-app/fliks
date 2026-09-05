import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { SubtitleLanguageItem } from '../../../common/constants/subtitle-flags';

export type {
  HearingImpairedMode,
  SubtitleLanguageItem,
} from '../../../common/constants/subtitle-flags';
export { resolveHearingImpairedMode } from '../../../common/constants/subtitle-flags';

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
