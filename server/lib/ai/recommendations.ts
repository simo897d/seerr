import type {
  JellyfinLibraryTitle,
  JellyfinWatchedItem,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { FeedbackStatus, TitleFeedback } from '@server/entity/TitleFeedback';
import type { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { AiRecommendation } from '@server/lib/ai/providers';
import { askForRecommendations } from '@server/lib/ai/providers';
import cacheManager from '@server/lib/cache';
import type { AiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

export type ResolvedRecommendation =
  | { mediaType: 'movie'; reason: string; result: TmdbMovieResult }
  | { mediaType: 'tv'; reason: string; result: TmdbTvResult };

interface TasteItem {
  title: string;
  type: 'movie' | 'tv';
  year?: number;
  tmdbId?: number;
  genres?: string[];
  favorite?: boolean;
}

export interface TasteProfile {
  liked: TasteItem[];
  disliked: TasteItem[];
  watched: TasteItem[];
  seenElsewhere: TasteItem[];
  requested: TasteItem[];
  watchlist: TasteItem[];
}

const MAX_RESULTS = 20;
// Ask for more than we show, since some won't match TMDB or are already known
const ASK_FOR = 30;
// Kids profiles drop anything TMDB doesn't tag as family content, so ask for more
const ASK_FOR_KIDS = 40;

// TMDB genre IDs
const GENRE_FAMILY = 10751;
const GENRE_KIDS = 10762;

const inFlight = new Map<string, Promise<ResolvedRecommendation[]>>();
// Bumped to drop a user's cached recommendations, e.g. after they change settings
const generations = new Map<number, number>();

const itemKey = (type: 'movie' | 'tv', tmdbId: number) => `${type}-${tmdbId}`;

const feedbackType = (item: TitleFeedback) =>
  item.mediaType === MediaType.MOVIE ? 'movie' : 'tv';

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const yearOf = (date?: string) => {
  const year = parseInt(date?.slice(0, 4) ?? '', 10);
  return Number.isFinite(year) ? year : undefined;
};

// Connects to Jellyfin/Emby as admin and works out which libraries to read
// for this user (all of them, unless they chose to ignore some).
const getJellyfinForUser = async (user: User) => {
  const settings = getSettings();

  if (
    ![MediaServerType.JELLYFIN, MediaServerType.EMBY].includes(
      settings.main.mediaServerType
    ) ||
    !user.jellyfinUserId ||
    !settings.jellyfin.apiKey
  ) {
    return undefined;
  }

  const jellyfin = new JellyfinAPI(getHostname(), settings.jellyfin.apiKey);
  const excluded = user.settings?.aiExcludedLibraries ?? [];

  let libraryIds: string[] | undefined;
  if (excluded.length) {
    const libraries = await jellyfin.getLibraries();
    libraryIds = libraries
      .map((library) => library.key)
      .filter((id) => !excluded.includes(id));
  }

  return { jellyfin, jellyfinUserId: user.jellyfinUserId, libraryIds };
};

/**
 * Movies and series on the media server this user hasn't finished, for
 * "what can I watch right now" questions.
 */
export const getUnwatchedOnServer = async (
  user: User
): Promise<JellyfinLibraryTitle[]> => {
  try {
    const server = await getJellyfinForUser(user);
    if (!server) {
      return [];
    }
    return await server.jellyfin.getUnwatchedItems(server.jellyfinUserId, {
      libraryIds: server.libraryIds,
    });
  } catch (e) {
    logger.warn('Could not load unwatched titles for AI chat', {
      label: 'AI Recommendations',
      userId: user.id,
      errorMessage: e.message,
    });
    return [];
  }
};

const getJellyfinHistory = async (
  user: User
): Promise<JellyfinWatchedItem[]> => {
  try {
    const server = await getJellyfinForUser(user);
    if (!server) {
      return [];
    }
    return await server.jellyfin.getUserWatchHistory(server.jellyfinUserId, {
      libraryIds: server.libraryIds,
    });
  } catch (e) {
    logger.warn('Could not load watch history for AI recommendations', {
      label: 'AI Recommendations',
      userId: user.id,
      errorMessage: e.message,
    });
    return [];
  }
};

const getRequestHistory = async (
  user: User,
  tmdb: TheMovieDb
): Promise<TasteItem[]> => {
  const requests = await getRepository(MediaRequest).find({
    where: { requestedBy: { id: user.id } },
    relations: { media: true },
    order: { createdAt: 'DESC' },
    take: 15,
  });

  const items = await Promise.all(
    requests.map(async (request): Promise<TasteItem | undefined> => {
      try {
        if (request.type === MediaType.MOVIE) {
          const movie = await tmdb.getMovie({ movieId: request.media.tmdbId });
          return {
            title: movie.title,
            type: 'movie',
            year: yearOf(movie.release_date),
            tmdbId: movie.id,
            genres: movie.genres.map((genre) => genre.name),
          };
        }

        const show = await tmdb.getTvShow({ tvId: request.media.tmdbId });
        return {
          title: show.name,
          type: 'tv',
          year: yearOf(show.first_air_date),
          tmdbId: show.id,
          genres: show.genres.map((genre) => genre.name),
        };
      } catch {
        return undefined;
      }
    })
  );

  return items.filter((item): item is TasteItem => !!item);
};

const getWatchlist = async (user: User): Promise<TasteItem[]> => {
  const watchlist = await getRepository(Watchlist).find({
    where: { requestedBy: { id: user.id } },
    order: { createdAt: 'DESC' },
    take: 20,
  });

  return watchlist.map((item) => ({
    title: item.title,
    type: item.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
    tmdbId: item.tmdbId,
  }));
};

export const getUserFeedback = (user: User) =>
  getRepository(TitleFeedback).find({
    where: { user: { id: user.id } },
    order: { updatedAt: 'DESC' },
  });

export const buildTasteProfile = async (
  user: User,
  tmdb: TheMovieDb
): Promise<TasteProfile> => {
  const [history, requested, watchlist, feedback] = await Promise.all([
    getJellyfinHistory(user),
    getRequestHistory(user, tmdb),
    getWatchlist(user),
    getUserFeedback(user),
  ]);

  const byStatus = (status: FeedbackStatus) =>
    feedback
      .filter((item) => item.status === status)
      .map(
        (item): TasteItem => ({
          title: item.title,
          type: feedbackType(item),
          year: item.year ?? undefined,
          tmdbId: item.tmdbId,
        })
      );

  // Rated titles are listed with their rating, so leave them out of the
  // plain watch history to avoid listing them twice.
  const rated = new Set(
    feedback.map((item) => itemKey(feedbackType(item), item.tmdbId))
  );

  return {
    liked: byStatus(FeedbackStatus.LIKED).slice(0, 40),
    disliked: byStatus(FeedbackStatus.DISLIKED).slice(0, 40),
    seenElsewhere: byStatus(FeedbackStatus.WATCHED).slice(0, 60),
    watched: history
      .filter(
        (item) => !item.tmdbId || !rated.has(itemKey(item.type, item.tmdbId))
      )
      .map((item) => ({
        title: item.name,
        type: item.type,
        year: item.year,
        tmdbId: item.tmdbId,
        genres: item.genres,
        favorite: item.favorite,
      })),
    requested,
    watchlist,
  };
};

const formatItem = (item: TasteItem) => {
  const parts = [
    `${item.title}${item.year ? ` (${item.year})` : ''}`,
    item.type === 'movie' ? 'movie' : 'TV series',
  ];
  if (item.genres?.length) {
    parts.push(item.genres.slice(0, 3).join('/'));
  }
  if (item.favorite) {
    parts.push('FAVORITE');
  }
  return `- ${parts.join(' | ')}`;
};

const SYSTEM_PROMPT = `You recommend movies and TV series to people using a self-hosted media server.
You receive what a person has watched, marked as favorite, requested and added to their watchlist, and you suggest titles they are likely to enjoy next.

Guidelines:
- Infer their taste from the whole history: genres, tone, themes, era, creators and pacing. Weight favorites and recent items most.
- Only suggest real, released titles that are listed on The Movie Database, using their original English title and first release year so they can be looked up.
- Titles they rated thumbs up are the strongest signal of their taste. Titles they rated thumbs down show what to steer away from, so avoid close matches to those.
- Never suggest anything that already appears anywhere in what you are given, including titles they disliked or have seen elsewhere.
- Mix well-known picks with less obvious ones they probably haven't seen. Avoid only suggesting the most popular titles of all time.
- Match the movie/TV balance of their history, but include some of each when the history has both.
- Keep each reason to one short sentence that names what in their history it connects to.
- Respond with JSON only.`;

export const KIDS_PROMPT = `

This profile belongs to a young child. Only suggest titles made for children and families, rated G or PG for movies or TV-Y, TV-Y7 or TV-G for series. Never suggest anything with mature themes, strong violence, horror or sexual content, even if it is animated. If their history contains grown-up titles, ignore those.`;

/** Describes what the user has watched, rated, requested and saved. */
export const formatTasteProfile = (profile: TasteProfile) => {
  const sections: string[] = [];
  const list = (items: TasteItem[]) => items.map(formatItem).join('\n');

  if (profile.liked.length) {
    sections.push(`Rated thumbs up (loved these):\n${list(profile.liked)}`);
  }
  if (profile.disliked.length) {
    sections.push(
      `Rated thumbs down (not for them):\n${list(profile.disliked)}`
    );
  }
  if (profile.watched.length) {
    sections.push(
      `Recently watched and favorites (newest first):\n${profile.watched
        .map(formatItem)
        .join('\n')}`
    );
  }
  if (profile.requested.length) {
    sections.push(
      `Recently requested:\n${profile.requested.map(formatItem).join('\n')}`
    );
  }
  if (profile.watchlist.length) {
    sections.push(
      `On their watchlist:\n${profile.watchlist.map(formatItem).join('\n')}`
    );
  }

  if (profile.seenElsewhere.length) {
    sections.push(
      `Already seen elsewhere (no rating given):\n${list(profile.seenElsewhere)}`
    );
  }

  return sections.join('\n\n');
};

const allItems = (profile: TasteProfile) => [
  ...profile.liked,
  ...profile.disliked,
  ...profile.watched,
  ...profile.seenElsewhere,
  ...profile.requested,
  ...profile.watchlist,
];

/** Every title in the profile, keyed like `movie-603`, so it isn't suggested again. */
export const profileKeys = (profile: TasteProfile) => ({
  ids: new Set(
    allItems(profile)
      .filter((item) => item.tmdbId)
      .map((item) => `${item.type}-${item.tmdbId}`)
  ),
  titles: new Set(
    allItems(profile).map(
      (item) => `${item.type}-${normalizeTitle(item.title)}`
    )
  ),
});

export { normalizeTitle };

const buildPrompt = (
  profile: TasteProfile,
  language: string,
  askFor: number
) => `${formatTasteProfile(profile)}

Suggest ${askFor} titles for this person. Write the reasons in the language with code "${language}".

Return a JSON object shaped like:
{"recommendations": [{"title": "...", "year": 2014, "mediaType": "movie" or "tv", "reason": "..."}]}`;

export const findOnTmdb = async (
  tmdb: TheMovieDb,
  suggestion: AiRecommendation
): Promise<ResolvedRecommendation | undefined> => {
  const wanted = normalizeTitle(suggestion.title);
  const year = suggestion.year ?? undefined;

  const pick = <T extends { title?: string; name?: string }>(
    results: T[],
    getTitles: (result: T) => (string | undefined)[]
  ) =>
    results.find((result) =>
      getTitles(result).some(
        (title) => title && normalizeTitle(title) === wanted
      )
    ) ?? results[0];

  try {
    if (suggestion.mediaType === 'movie') {
      let { results } = await tmdb.searchMovies({
        query: suggestion.title,
        year,
      });
      if (!results.length && year) {
        ({ results } = await tmdb.searchMovies({ query: suggestion.title }));
      }
      const result = pick(results, (r) => [r.title, r.original_title]);
      return result
        ? { mediaType: 'movie', reason: suggestion.reason, result }
        : undefined;
    }

    let { results } = await tmdb.searchTvShows({
      query: suggestion.title,
      year,
    });
    if (!results.length && year) {
      ({ results } = await tmdb.searchTvShows({ query: suggestion.title }));
    }
    const result = pick(results, (r) => [r.name, r.original_name]);
    return result
      ? { mediaType: 'tv', reason: suggestion.reason, result }
      : undefined;
  } catch {
    return undefined;
  }
};

// Runs the lookups a few at a time so we don't hammer TMDB
export const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    })
  );

  return results;
};

// Kids profiles only get titles TMDB tags as family (or kids, for series)
export const isKidFriendly = (item: ResolvedRecommendation) => {
  if ('adult' in item.result && item.result.adult) {
    return false;
  }
  const genres = item.result.genre_ids ?? [];
  return item.mediaType === 'movie'
    ? genres.includes(GENRE_FAMILY)
    : genres.includes(GENRE_FAMILY) || genres.includes(GENRE_KIDS);
};

const generate = async (
  user: User,
  aiSettings: AiSettings,
  language: string
): Promise<ResolvedRecommendation[]> => {
  const tmdb = new TheMovieDb();
  const kidsMode = !!user.settings?.aiKidsMode;
  const profile = await buildTasteProfile(user, tmdb);

  if (!allItems(profile).length) {
    logger.debug('No history yet, skipping AI recommendations', {
      label: 'AI Recommendations',
      userId: user.id,
    });
    return [];
  }

  const started = Date.now();
  const suggestions = await askForRecommendations(
    aiSettings,
    kidsMode ? SYSTEM_PROMPT + KIDS_PROMPT : SYSTEM_PROMPT,
    buildPrompt(profile, language, kidsMode ? ASK_FOR_KIDS : ASK_FOR)
  );

  const { ids: knownIds, titles: knownTitles } = profileKeys(profile);

  const resolved = await mapWithConcurrency(
    suggestions.filter(
      (s) => !knownTitles.has(`${s.mediaType}-${normalizeTitle(s.title)}`)
    ),
    5,
    (suggestion) => findOnTmdb(tmdb, suggestion)
  );

  const seen = new Set<string>();
  const recommendations = resolved.filter(
    (item): item is ResolvedRecommendation => {
      if (!item) {
        return false;
      }
      const key = `${item.mediaType}-${item.result.id}`;
      if (knownIds.has(key) || seen.has(key)) {
        return false;
      }
      if (kidsMode && !isKidFriendly(item)) {
        return false;
      }
      seen.add(key);
      return true;
    }
  );

  logger.info('Generated AI recommendations', {
    label: 'AI Recommendations',
    userId: user.id,
    provider: aiSettings.provider,
    model: aiSettings.model,
    kidsMode,
    suggested: suggestions.length,
    matched: recommendations.length,
    durationMs: Date.now() - started,
  });

  return recommendations.slice(0, MAX_RESULTS);
};

export const OWNER_ONLY_MESSAGE =
  "AI runs on the server owner's Claude subscription, so only the owner can use it.";

/**
 * With the Claude Code provider, AI runs on the owner's own Claude
 * subscription, which isn't for sharing, so nobody else gets it.
 */
export const canUseAi = (user: User, aiSettings = getSettings().ai) =>
  aiSettings.provider !== 'claude-code' || user.id === 1;

/**
 * Returns personalized recommendations for a user, cached per user.
 * Pass `aiSettings` to try unsaved settings (no caching is done then).
 */
export const getAiRecommendations = async (
  user: User,
  {
    language = 'en',
    aiSettings,
    refresh = false,
  }: { language?: string; aiSettings?: AiSettings; refresh?: boolean } = {}
): Promise<ResolvedRecommendation[]> => {
  if (!canUseAi(user, aiSettings)) {
    if (aiSettings) {
      throw new Error(OWNER_ONLY_MESSAGE);
    }
    return [];
  }

  if (aiSettings) {
    return generate(user, aiSettings, language);
  }

  const settings = getSettings().ai;
  const cache = cacheManager.getCache('ai').data;
  const cacheKey = `user-${user.id}-${language}-${generations.get(user.id) ?? 0}`;

  // Titles rated after the list was made drop out straight away; the
  // ratings themselves shape the next list.
  const withoutRated = async (list: ResolvedRecommendation[]) => {
    const feedback = await getUserFeedback(user);
    const rated = new Set(
      feedback.map((item) => itemKey(feedbackType(item), item.tmdbId))
    );
    return list.filter(
      (item) => !rated.has(itemKey(item.mediaType, item.result.id))
    );
  };

  if (!refresh) {
    const cached = cache.get<ResolvedRecommendation[]>(cacheKey);
    if (cached) {
      return withoutRated(cached);
    }
  }

  // Discover can ask for the same user's list several times while the first
  // request is still waiting on the AI; share that one request.
  const pending = inFlight.get(cacheKey);
  if (pending) {
    return pending.then(withoutRated);
  }

  const request = generate(user, settings, language)
    .then((recommendations) => {
      // Cache empty results briefly so new users get suggestions soon after
      // they start watching.
      const ttl = recommendations.length
        ? Math.max(1, settings.cacheHours) * 3600
        : 900;
      cache.set(cacheKey, recommendations, ttl);
      return recommendations;
    })
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, request);
  return request.then(withoutRated);
};

/**
 * Drops a user's cached recommendations so the next visit to Discover asks
 * the AI again, e.g. after their AI settings change.
 */
export const clearAiRecommendations = (userId: number) => {
  generations.set(userId, (generations.get(userId) ?? 0) + 1);
};

/** Changes whenever the user's cached AI data should be thrown away. */
export const getAiGeneration = (userId: number) => generations.get(userId) ?? 0;
