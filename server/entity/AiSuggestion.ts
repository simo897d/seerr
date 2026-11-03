import type { MediaType } from '@server/constants/media';
import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum SuggestionOutcome {
  // Still in their recommendations, nothing done with it yet
  PENDING = 'pending',
  // Requested or added to the watchlist, not watched yet
  REQUESTED = 'requested',
  WATCHED = 'watched',
  // Rated thumbs down
  DISLIKED = 'disliked',
  // Shown again and again over weeks, never picked
  SKIPPED = 'skipped',
}

/**
 * A title the AI recommended to a user, and what they did with it. Lets the
 * next recommendations learn which kinds of picks land and which don't.
 */
@Entity()
@Unique('UNIQUE_AI_SUGGESTION', ['user', 'tmdbId', 'mediaType'])
export class AiSuggestion {
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
  public title: string;

  @Column({ type: 'integer', nullable: true })
  public year?: number | null;

  // The AI's reason, so it can see why the pick did or didn't work
  @Column({ type: 'varchar', default: '' })
  public reason: string;

  @Column({ type: 'varchar', default: SuggestionOutcome.PENDING })
  public outcome: SuggestionOutcome;

  // How many separate recommendation lists it appeared in
  @Column({ type: 'integer', default: 1 })
  public timesShown: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstShownAt: Date;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public lastShownAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  constructor(init?: Partial<AiSuggestion>) {
    Object.assign(this, init);
  }
}
