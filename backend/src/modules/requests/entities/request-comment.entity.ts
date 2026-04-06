import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
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

  @Column()
  requestId: number;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  userId: number;

  @Column({ type: 'text' })
  message: string;
}
