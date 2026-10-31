import type { JellyfinWatchedItem } from '@server/api/jellyfin';
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

interface TasteProfile {
  watched: TasteItem[];
  requested: TasteItem[];
  watchlist: TasteItem[];
}

const MAX_RESULTS = 20;
// Ask for more than we show, since some won't match TMDB or are already known
const ASK_FOR = 30;

const inFlight = new Map<number, Promise<ResolvedRecommendation[]>>();

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

const getJellyfinHistory = async (
  user: User
): Promise<JellyfinWatchedItem[]> => {
  const settings = getSettings();

  if (
    ![MediaServerType.JELLYFIN, MediaServerType.EMBY].includes(
      settings.main.mediaServerType
    ) ||
    !user.jellyfinUserId ||
    !settings.jellyfin.apiKey
  ) {
    return [];
  }

  try {
    const jellyfin = new JellyfinAPI(getHostname(), settings.jellyfin.apiKey);
    return await jellyfin.getUserWatchHistory(user.jellyfinUserId);
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

const buildTasteProfile = async (
  user: User,
  tmdb: TheMovieDb
): Promise<TasteProfile> => {
  const [history, requested, watchlist] = await Promise.all([
    getJellyfinHistory(user),
    getRequestHistory(user, tmdb),
    getWatchlist(user),
  ]);

  return {
    watched: history.map((item) => ({
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
- Never suggest anything that already appears in their history.
- Mix well-known picks with less obvious ones they probably haven't seen. Avoid only suggesting the most popular titles of all time.
- Match the movie/TV balance of their history, but include some of each when the history has both.
- Keep each reason to one short sentence that names what in their history it connects to.
- Respond with JSON only.`;

const buildPrompt = (profile: TasteProfile, language: string) => {
  const sections: string[] = [];

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

  return `${sections.join('\n\n')}

Suggest ${ASK_FOR} titles for this person. Write the reasons in the language with code "${language}".

Return a JSON object shaped like:
{"recommendations": [{"title": "...", "year": 2014, "mediaType": "movie" or "tv", "reason": "..."}]}`;
};

const findOnTmdb = async (
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
const mapWithConcurrency = async <T, R>(
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

const generate = async (
  user: User,
  aiSettings: AiSettings,
  language: string
): Promise<ResolvedRecommendation[]> => {
  const tmdb = new TheMovieDb();
  const profile = await buildTasteProfile(user, tmdb);
  const known = [
    ...profile.watched,
    ...profile.requested,
    ...profile.watchlist,
  ];

  if (!known.length) {
    logger.debug('No history yet, skipping AI recommendations', {
      label: 'AI Recommendations',
      userId: user.id,
    });
    return [];
  }

  const started = Date.now();
  const suggestions = await askForRecommendations(
    aiSettings,
    SYSTEM_PROMPT,
    buildPrompt(profile, language)
  );

  const knownIds = new Set(
    known
      .filter((item) => item.tmdbId)
      .map((item) => `${item.type}-${item.tmdbId}`)
  );
  const knownTitles = new Set(
    known.map((item) => `${item.type}-${normalizeTitle(item.title)}`)
  );

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
      seen.add(key);
      return true;
    }
  );

  logger.info('Generated AI recommendations', {
    label: 'AI Recommendations',
    userId: user.id,
    provider: aiSettings.provider,
    model: aiSettings.model,
    suggested: suggestions.length,
    matched: recommendations.length,
    durationMs: Date.now() - started,
  });

  return recommendations.slice(0, MAX_RESULTS);
};

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
  if (aiSettings) {
    return generate(user, aiSettings, language);
  }

  const settings = getSettings().ai;
  const cache = cacheManager.getCache('ai').data;
  const cacheKey = `user-${user.id}-${language}`;

  if (!refresh) {
    const cached = cache.get<ResolvedRecommendation[]>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Discover can ask for the same user's list several times while the first
  // request is still waiting on the AI; share that one request.
  const pending = inFlight.get(user.id);
  if (pending) {
    return pending;
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
    .finally(() => inFlight.delete(user.id));

  inFlight.set(user.id, request);
  return request;
};
