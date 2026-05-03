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

export interface SubtitleLanguageItem {
  isoCode: string;
  name: string;
  forced: boolean;
  hi: boolean;
}
