import { Entity, Column, CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity('indexer_stats')
export class IndexerStat {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
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
