import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('language_profiles')
export class LanguageProfile extends BaseEntity {
  @Column()
  name: string;

  @Column()
  cutoff: number;

  @Column({ type: 'jsonb' })
  languages: LanguageProfileItem[];
}

export interface LanguageProfileItem {
  language: {
    id: number;
    name: string;
    isoCode: string;
  };
  allowed: boolean;
  sortOrder: number;
}
