import type { JellyfinLibraryTitle } from '@server/api/jellyfin';
import TheMovieDb from '@server/api/themoviedb';
import type { User } from '@server/entity/User';
import type { ChatTurn } from '@server/lib/ai/providers';
import { askForChatReply } from '@server/lib/ai/providers';
import type { ResolvedRecommendation } from '@server/lib/ai/recommendations';
import {
  KIDS_PROMPT,
  OWNER_ONLY_MESSAGE,
  buildTasteProfile,
  canUseAi,
  findOnTmdb,
  formatTasteProfile,
  getAiGeneration,
  getUnwatchedOnServer,
  isKidFriendly,
  mapWithConcurrency,
} from '@server/lib/ai/recommendations';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

// Keeps each request small and cheap
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 1500;
const MAX_TITLES = 8;
// Per user, to keep a runaway client (or a curious kid) from running up a bill
const MESSAGES_PER_HOUR = 40;
// The background info is rebuilt at most this often, so ratings show up soon
const CONTEXT_TTL_SECONDS = 600;

export class ChatLimitError extends Error {}
export class ChatNotAllowedError extends Error {}

const recentMessages = new Map<number, number[]>();

const checkRateLimit = (userId: number) => {
  const hourAgo = Date.now() - 3600_000;
  const times = (recentMessages.get(userId) ?? []).filter((t) => t > hourAgo);
  if (times.length >= MESSAGES_PER_HOUR) {
    throw new ChatLimitError(
      `You can send ${MESSAGES_PER_HOUR} messages an hour. Try again a bit later.`
    );
  }
  times.push(Date.now());
  recentMessages.set(userId, times);
};

const formatLibraryTitle = (item: JellyfinLibraryTitle) => {
  const parts = [
    `${item.name}${item.year ? ` (${item.year})` : ''}`,
    item.type === 'movie' ? 'movie' : 'TV series',
  ];
  if (item.runtimeMinutes && item.type === 'movie') {
    parts.push(`${item.runtimeMinutes} min`);
  }
  if (item.genres.length) {
    parts.push(item.genres.slice(0, 3).join('/'));
  }
  if (item.rating) {
    parts.push(`rated ${item.rating.toFixed(1)}`);
  }
  return `- ${parts.join(' | ')}`;
};

const SYSTEM_PROMPT = `You are a friendly movie and TV assistant inside Seerr, a self-hosted app where people browse, request and watch movies and series from their own media server.

Guidelines:
- Keep replies short and conversational: a sentence or two, then your picks with a few words on why each fits. Plain text only, no markdown headings, tables or bold.
- When they want something to watch now or tonight, pick from "On their server" first, since those can be played straight away. If you suggest something that isn't there, say they can request it.
- Base picks on their taste below. Don't suggest anything they disliked or have already seen unless they ask about it.
- List every movie or series you mention by name in "titles" (at most ${MAX_TITLES}), using its original English title and first release year, in the order you mention them.
- Stick to movies, TV and closely related topics. Politely steer anything else back.
- Reply in the language the user writes in.`;

interface ChatContext {
  system: string;
}

const buildContext = async (user: User): Promise<ChatContext> => {
  const cache = cacheManager.getCache('ai').data;
  const cacheKey = `chat-${user.id}-${getAiGeneration(user.id)}`;
  const cached = cache.get<ChatContext>(cacheKey);
  if (cached) {
    return cached;
  }

  const [profile, unwatched] = await Promise.all([
    buildTasteProfile(user, new TheMovieDb()),
    getUnwatchedOnServer(user),
  ]);

  const sections = [
    SYSTEM_PROMPT,
    user.settings?.aiKidsMode ? KIDS_PROMPT.trim() : '',
    `Today is ${new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })}.`,
    `What we know about this person:\n${
      formatTasteProfile(profile) || 'Nothing yet.'
    }`,
    unwatched.length
      ? `On their server and not finished yet (they can watch these now):\n${unwatched
          .map(formatLibraryTitle)
          .join('\n')}`
      : '',
  ];

  const context = {
    system: sections.filter(Boolean).join('\n\n'),
  };
  cache.set(cacheKey, context, CONTEXT_TTL_SECONDS);
  return context;
};

export interface ChatAnswer {
  reply: string;
  titles: ResolvedRecommendation[];
}

/**
 * Answers a message like "what should I watch tonight?" using the user's
 * taste and what's on their server. The client keeps the conversation and
 * sends it each time; only the most recent turns are used.
 */
export const chatWithAi = async (
  user: User,
  turns: ChatTurn[]
): Promise<ChatAnswer> => {
  if (!canUseAi(user)) {
    throw new ChatNotAllowedError(OWNER_ONLY_MESSAGE);
  }
  checkRateLimit(user.id);

  const settings = getSettings().ai;
  const context = await buildContext(user);
  const kidsMode = !!user.settings?.aiKidsMode;

  // Must start with a user turn and end with one
  let recent = turns.slice(-MAX_TURNS).map((turn) => ({
    role: turn.role,
    content: turn.content.slice(0, MAX_TURN_CHARS),
  }));
  while (recent.length && recent[0].role !== 'user') {
    recent = recent.slice(1);
  }

  const started = Date.now();
  const answer = await askForChatReply(settings, context.system, recent);

  // Show posters for what the AI named, in the order it named them
  const tmdb = new TheMovieDb();
  const resolved = await mapWithConcurrency(
    answer.titles.slice(0, MAX_TITLES),
    4,
    (title) => findOnTmdb(tmdb, { ...title, reason: '' })
  );

  const seen = new Set<string>();
  const titles = resolved.filter((item): item is ResolvedRecommendation => {
    if (!item) {
      return false;
    }
    const key = `${item.mediaType}-${item.result.id}`;
    if (seen.has(key) || (kidsMode && !isKidFriendly(item))) {
      return false;
    }
    seen.add(key);
    return true;
  });

  logger.info('Answered AI chat message', {
    label: 'AI Recommendations',
    userId: user.id,
    provider: settings.provider,
    turns: recent.length,
    titles: titles.length,
    durationMs: Date.now() - started,
  });

  return { reply: answer.reply, titles };
};
