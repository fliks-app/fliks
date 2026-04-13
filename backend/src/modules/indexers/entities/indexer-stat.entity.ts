import {
  Entity,
  Column,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { Indexer } from './indexer.entity';

@Entity('indexer_stats')
export class IndexerStat {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Indexer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'indexerId' })
  indexer: Indexer;

  @RelationId((s: IndexerStat) => s.indexer)
  indexerId: number;

  @CreateDateColumn()
  queryDate: Date;

  @Column({ default: 'search' })
  queryType: string; // 'search' | 'rss' | 'tvsearch' | 'season'

  @Column({ type: 'int', default: 0 })
  responseTimeMs: number;

  @Column({ type: 'int', default: 0 })
  resultCount: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;
}
