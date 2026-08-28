import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums';

@Entity('auto_approval_rules')
export class AutoApprovalRule extends BaseEntity {
  @Column()
  name: string;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb' })
  criteria: AutoApprovalCriteria;
}

/**
 * Every set criterion must match; an unset one matches anything, so `{}`
 * auto-approves every request. `userIds` and `roleIds` are OR'd together
 * (the requester is one of these users *or* holds one of these roles).
 * Rules themselves are OR'd: one match approves.
 */
export interface AutoApprovalCriteria {
  userIds?: number[];
  roleIds?: number[];
  mediaType?: MediaType;
  libraryIds?: number[];
  /** TMDB genre ids, OR'd: the title must carry at least one. */
  genreIds?: number[];
  /** Series only. Compared against the requested season count, or the
   *  show's total when the request covers the whole series. */
  maxSeasons?: number;
  yearFrom?: number;
  yearTo?: number;
}
