import type { MediaType } from '@server/constants/media';
import { User } from '@server/entity/User';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum FeedbackStatus {
  // Seen somewhere else, no opinion given
  WATCHED = 'watched',
  LIKED = 'liked',
  // Watched it, it was OK: neither loved nor disliked
  MEH = 'meh',
  DISLIKED = 'disliked',
}

/**
 * What a user has told us about a title: that they've seen it, loved it,
 * found it OK or didn't like it. Used to tailor AI recommendations.
 */
@Entity()
@Unique('UNIQUE_TITLE_FEEDBACK', ['user', 'tmdbId', 'mediaType'])
export class TitleFeedback {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @Index()
  public user: User;

  @Column()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar' })
  public status: FeedbackStatus;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'integer', nullable: true })
  public year?: number | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<TitleFeedback>) {
    Object.assign(this, init);
  }
}
