import {
  Entity,
  Column,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { SubtitleProvider } from './subtitle-provider.entity';

@Entity('subtitle_provider_stats')
export class SubtitleProviderStat {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => SubtitleProvider, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'providerId' })
  provider: SubtitleProvider;

  @RelationId((s: SubtitleProviderStat) => s.provider)
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
