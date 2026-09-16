import { Entity, Column, ManyToOne, JoinColumn, RelationId, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { LiveTvChannel } from './livetv-channel.entity';

/** Per-user curation of a shared lineup: a phone and a TV agree on favourites. */
@Entity('livetv_user_channel_prefs')
@Index('UQ_livetv_pref_user_channel', ['user', 'channel'], { unique: true })
export class LiveTvUserChannelPref extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((p: LiveTvUserChannelPref) => p.user)
  userId: number;

  @ManyToOne(() => LiveTvChannel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: LiveTvChannel;

  @RelationId((p: LiveTvUserChannelPref) => p.channel)
  channelId: number;

  @Column({ type: 'boolean', default: false })
  favorite: boolean;

  @Column({ type: 'boolean', default: false })
  hidden: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastPlayedAt: Date | null;
}
