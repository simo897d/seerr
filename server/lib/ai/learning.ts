import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { AiSuggestion, SuggestionOutcome } from '@server/entity/AiSuggestion';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { TitleFeedback } from '@server/entity/TitleFeedback';
import { FeedbackStatus } from '@server/entity/TitleFeedback';
import type { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { ResolvedRecommendation } from '@server/lib/ai/recommendations';
import logger from '@server/logger';
import { In } from 'typeorm';

/**
 * Remembers what the AI recommended to each user and what they did with it:
 * watched it, requested it, rated it down, or kept scrolling past it. The
 * next recommendations are told which earlier picks landed and which didn't.
 */

// A pick counts as skipped once it has been in this many lists...
const SKIP_AFTER_SHOWINGS = 2;
// ...over at least this many days without being watched or requested
const SKIP_AFTER_DAYS = 14;
// Picks that were only in one list and never came back say nothing either
// way, so they are dropped after a while
const FORGET_UNSEEN_AFTER_DAYS = 60;

const PICKED_UP_LIMIT = 25;
const PASSED_ON_LIMIT = 40;

const DAY_MS = 86_400_000;

const keyOf = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}-${tmdbId}`;

/**
 * Saves a newly made list of recommendations. New titles are added; titles
 * still waiting from an earlier list count one more showing.
 */
export const recordSuggestions = async (
  user: User,
  recommendations: ResolvedRecommendation[]
) => {
  if (!recommendations.length) {
    return;
  }

  try {
    const repository = getRepository(AiSuggestion);
    const existing = await repository.find({
      where: {
        user: { id: user.id },
        tmdbId: In(recommendations.map((item) => item.result.id)),
      },
    });
    const byKey = new Map(
      existing.map((item) => [keyOf(item.mediaType, item.tmdbId), item])
    );

    const now = new Date();
    const changed: AiSuggestion[] = [];

    for (const item of recommendations) {
      const mediaType =
        item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
      const saved = byKey.get(keyOf(mediaType, item.result.id));

      if (!saved) {
        const date =
          item.mediaType === 'movie'
            ? item.result.release_date
            : item.result.first_air_date;
        const year = parseInt(date?.slice(0, 4) ?? '', 10);
        changed.push(
          new AiSuggestion({
            user,
            tmdbId: item.result.id,
            mediaType,
            title:
              item.mediaType === 'movie' ? item.result.title : item.result.name,
            year: Number.isFinite(year) ? year : null,
            reason: item.reason.slice(0, 300),
            outcome: SuggestionOutcome.PENDING,
            timesShown: 1,
            firstShownAt: now,
            lastShownAt: now,
          })
        );
      } else if (saved.outcome === SuggestionOutcome.PENDING) {
        saved.timesShown += 1;
        saved.lastShownAt = now;
        saved.reason = item.reason.slice(0, 300) || saved.reason;
        changed.push(saved);
      }
    }

    await repository.save(changed);
  } catch (e) {
    logger.warn('Could not save AI suggestions', {
      label: 'AI Recommendations',
      userId: user.id,
      errorMessage: e.message,
    });
  }
};

export interface SuggestionHistory {
  // Picks they watched or requested, newest first
  pickedUp: AiSuggestion[];
  // Picks they kept passing on, newest first
  passedOn: AiSuggestion[];
}

/**
 * Works out what happened to earlier picks and returns the ones worth
 * telling the AI about. `isWatched` checks the media server history.
 */
export const updateSuggestionOutcomes = async (
  user: User,
  {
    isWatched,
    feedback,
  }: {
    isWatched: (suggestion: AiSuggestion) => boolean;
    feedback: TitleFeedback[];
  }
): Promise<SuggestionHistory> => {
  const repository = getRepository(AiSuggestion);

  try {
    const open = await repository.find({
      where: {
        user: { id: user.id },
        outcome: In([
          SuggestionOutcome.PENDING,
          SuggestionOutcome.REQUESTED,
          // A skipped pick they get round to later still counts
          SuggestionOutcome.SKIPPED,
          // A watched pick can still be rated down afterwards
          SuggestionOutcome.WATCHED,
        ]),
      },
    });

    if (open.length) {
      const ids = open.map((item) => item.tmdbId);
      const [requests, watchlist] = await Promise.all([
        getRepository(MediaRequest).find({
          where: { requestedBy: { id: user.id }, media: { tmdbId: In(ids) } },
          relations: { media: true },
        }),
        getRepository(Watchlist).find({
          where: { requestedBy: { id: user.id }, tmdbId: In(ids) },
        }),
      ]);

      const requested = new Set([
        ...requests.map((request) =>
          keyOf(request.media.mediaType, request.media.tmdbId)
        ),
        ...watchlist.map((item) => keyOf(item.mediaType, item.tmdbId)),
      ]);
      const rated = new Map(
        feedback.map((item) => [keyOf(item.mediaType, item.tmdbId), item])
      );

      const now = new Date();
      const changed: AiSuggestion[] = [];
      const forgotten: AiSuggestion[] = [];

      for (const suggestion of open) {
        const key = keyOf(suggestion.mediaType, suggestion.tmdbId);
        const rating = rated.get(key)?.status;
        let outcome = suggestion.outcome;

        // Watched stays watched, unless they rate it down later
        if (
          outcome === SuggestionOutcome.WATCHED &&
          rating !== FeedbackStatus.DISLIKED
        ) {
          continue;
        }

        if (rating === FeedbackStatus.DISLIKED) {
          outcome = SuggestionOutcome.DISLIKED;
        } else if (rating || isWatched(suggestion)) {
          outcome = SuggestionOutcome.WATCHED;
        } else if (requested.has(key)) {
          outcome = SuggestionOutcome.REQUESTED;
        } else if (
          suggestion.outcome === SuggestionOutcome.PENDING &&
          suggestion.timesShown >= SKIP_AFTER_SHOWINGS &&
          now.getTime() - new Date(suggestion.firstShownAt).getTime() >=
            SKIP_AFTER_DAYS * DAY_MS
        ) {
          outcome = SuggestionOutcome.SKIPPED;
        } else if (
          suggestion.outcome === SuggestionOutcome.PENDING &&
          suggestion.timesShown < SKIP_AFTER_SHOWINGS &&
          now.getTime() - new Date(suggestion.lastShownAt).getTime() >=
            FORGET_UNSEEN_AFTER_DAYS * DAY_MS
        ) {
          forgotten.push(suggestion);
          continue;
        }

        if (outcome !== suggestion.outcome) {
          suggestion.outcome = outcome;
          suggestion.resolvedAt = now;
          changed.push(suggestion);
        }
      }

      await repository.save(changed);
      if (forgotten.length) {
        await repository.remove(forgotten);
      }

      if (changed.length) {
        logger.debug('Updated what happened to earlier AI suggestions', {
          label: 'AI Recommendations',
          userId: user.id,
          changes: changed.map(
            (item) => `${item.title} (${item.mediaType}): ${item.outcome}`
          ),
        });
      }
    }

    const [pickedUp, passedOn] = await Promise.all([
      repository.find({
        where: {
          user: { id: user.id },
          outcome: In([SuggestionOutcome.WATCHED, SuggestionOutcome.REQUESTED]),
        },
        order: { resolvedAt: 'DESC' },
        take: PICKED_UP_LIMIT,
      }),
      repository.find({
        where: { user: { id: user.id }, outcome: SuggestionOutcome.SKIPPED },
        order: { resolvedAt: 'DESC' },
        take: PASSED_ON_LIMIT,
      }),
    ]);

    return { pickedUp, passedOn };
  } catch (e) {
    logger.warn('Could not check earlier AI suggestions', {
      label: 'AI Recommendations',
      userId: user.id,
      errorMessage: e.message,
    });
    return { pickedUp: [], passedOn: [] };
  }
};
