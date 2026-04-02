import {
  Entity,
  Column,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('subtitle_provider_stats')
export class SubtitleProviderStat {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  providerId: number;

  @CreateDateColumn()
  queryDate: Date;

  @Column({ default: 'search' })
  queryType: string; // 'search' | 'download'

  @Column({ type: 'int', default: 0 })
  responseTimeMs: number;

  @Column({ type: 'int', default: 0 })
  resultCount: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;
}
