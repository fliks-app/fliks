import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { Episode } from '../../media/entities/episode.entity';
import { TranslationProvider } from './translation-provider.entity';
import { normalizeLanguageCode } from '../../../common/constants/app-languages';

@Entity('subtitle_files')
export class SubtitleFile extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((sf: SubtitleFile) => sf.media)
  mediaId: number;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((sf: SubtitleFile) => sf.episode)
  episodeId: number;

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @RelationId((sf: SubtitleFile) => sf.mediaFile)
  mediaFileId: number;

  /**
   * Stored canonical: the transformer folds every write to an ISO 639-1 code
   * (regional/script forms like `pt-BR`→`pt`, ISO 639-2 like `fre`→`fr`) so
   * language matching against a profile isoCode never misses on a variant.
   * NB: raw QueryBuilder writes bypass transformers — always persist via the
   * repository so this invariant holds.
   */
  @Column({
    transformer: {
      to: (value: string | null | undefined) => normalizeLanguageCode(value),
      from: (value: string) => value,
    },
  })
  language: string;

  @Column({ default: false })
  forced: boolean;

  @Column({ default: false })
  hearingImpaired: boolean;

  @Column({ type: 'enum', enum: SubtitleProviderType })
  providerType: SubtitleProviderType;

  @Column({ nullable: true })
  providerFileId: string;

  /** Path relative to Media.path (same convention as MediaFile.relativePath). DB column remains `filePath`. */
  @Column({ name: 'filePath', type: 'varchar', nullable: true })
  relativePath: string | null;

  @Column({
    type: 'enum',
    enum: SubtitleStatus,
    default: SubtitleStatus.DOWNLOADED,
  })
  status: SubtitleStatus;

  @Column({ type: 'int', nullable: true })
  streamIndex: number | null;

  /** For OCR results: the stream index of the source image track they were
   *  extracted from. Lets a rescan skip re-adding a burn-required track that
   *  was already OCR'd-and-removed (its language may be undetermined). */
  @Column({ type: 'int', nullable: true })
  sourceStreamIndex: number | null;

  @Column({ type: 'varchar', nullable: true })
  codec: string | null;

  @Column({ type: 'int', default: 0 })
  score: number;

  /**
   * True when the candidate this row was downloaded from came out of a
   * hash-based provider lookup (e.g. OpenSubtitles moviehash). Used by
   * the upgrade pass as a guard: a hash-matched sub is the perfect time
   * sync, so non-hash candidates can't replace it on score alone.
   */
  @Column({ default: false })
  hashMatched: boolean;

  @Column({ default: false })
  synced: boolean;

  @Column({ type: 'int', nullable: true })
  syncOffset: number;

  @Column({ default: false })
  locked: boolean;

  @Column('simple-json', { default: '[]' })
  tags: string[];

  /** For TRANSLATED subs: the provider that produced this file. Nulled if the
   *  provider is later removed; the engine/model snapshot below preserves the
   *  provenance regardless. */
  @ManyToOne(() => TranslationProvider, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'translationProviderId' })
  translationProvider: TranslationProvider | null;

  @RelationId((sf: SubtitleFile) => sf.translationProvider)
  translationProviderId: number | null;

  @Column({ type: 'varchar', nullable: true })
  translationEngine: string | null;

  @Column({ type: 'varchar', nullable: true })
  translationModel: string | null;
}
