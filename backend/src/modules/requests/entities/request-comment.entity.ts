import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { FliksRequest } from './request.entity';

@Entity('request_comments')
export class RequestComment extends BaseEntity {
  @ManyToOne(() => FliksRequest, (request) => request.comments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'requestId' })
  request: FliksRequest;

  @RelationId((c: RequestComment) => c.request)
  requestId: number;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((c: RequestComment) => c.user)
  userId: number;

  @Column({ type: 'text' })
  message: string;
}
