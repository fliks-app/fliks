import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Condition kinds a custom format can test. Every one but `title_regex` and
 * `release_flag` matches the *parsed* attribute of a release, never a substring
 * of its name: `language:it` as a substring hits any title containing "it".
 */
export const CUSTOM_FORMAT_SPEC_TYPES = [
  'title_regex',
  'source',
  'resolution',
  'language',
  'release_flag',
  'release_group',
  'edition',
  'video_codec',
  'audio_codec',
] as const;

export type CustomFormatSpecType = (typeof CUSTOM_FORMAT_SPEC_TYPES)[number];

export interface CustomFormatSpec {
  type: CustomFormatSpecType;
  value: string;
  negate?: boolean;
  required?: boolean;
}

@Entity('custom_formats')
export class CustomFormat extends BaseEntity {
  @Column()
  name: string;

  /** Points added to a release score when the format matches */
  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ type: 'jsonb', default: [] })
  specs: CustomFormatSpec[];
}
