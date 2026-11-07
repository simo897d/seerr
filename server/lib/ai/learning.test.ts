import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TmdbMovieResult } from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { AiSuggestion, SuggestionOutcome } from '@server/entity/AiSuggestion';
import { FeedbackStatus, TitleFeedback } from '@server/entity/TitleFeedback';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { readClaudeCodeOutput } from '@server/lib/ai/claudeCode';
import {
  recordSuggestions,
  updateSuggestionOutcomes,
} from '@server/lib/ai/learning';
import type {
  ResolvedRecommendation,
  TasteProfile,
} from '@server/lib/ai/recommendations';
import {
  basedOnFinder,
  formatTasteProfile,
} from '@server/lib/ai/recommendations';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const DAY_MS = 86_400_000;

const movie = (id: number, title: string): ResolvedRecommendation => ({
  mediaType: 'movie',
  reason: `Because of ${title}`,
  result: { id, title, release_date: '2010-07-16' } as TmdbMovieResult,
});

const getUser = () =>
  getRepository(User).findOneOrFail({ where: { email: 'admin@seerr.dev' } });

const suggestionsOf = async (user: User) =>
  new Map(
    (
      await getRepository(AiSuggestion).find({
        where: { user: { id: user.id } },
      })
    ).map((item) => [item.title, item])
  );

// Pretends a suggestion was first shown some days ago
const age = async (user: User, title: string, days: number) => {
  const item = (await suggestionsOf(user)).get(title);
  assert.ok(item);
  item.firstShownAt = new Date(Date.now() - days * DAY_MS);
  item.lastShownAt = item.firstShownAt;
  await getRepository(AiSuggestion).save(item);
};

describe('AI suggestion learning', () => {
  it('records new picks and counts repeat showings', async () => {
    const user = await getUser();

    await recordSuggestions(user, [movie(1, 'Inception'), movie(2, 'Heat')]);
    await recordSuggestions(user, [movie(1, 'Inception')]);

    const saved = await suggestionsOf(user);
    assert.equal(saved.get('Inception')?.timesShown, 2);
    assert.equal(saved.get('Heat')?.timesShown, 1);
    assert.equal(saved.get('Inception')?.year, 2010);
    assert.equal(saved.get('Inception')?.outcome, SuggestionOutcome.PENDING);
  });

  it('sorts picks into watched, requested, disliked and skipped', async () => {
    const user = await getUser();

    await recordSuggestions(user, [
      movie(1, 'Inception'),
      movie(2, 'Heat'),
      movie(3, 'Alien'),
      movie(4, 'Fargo'),
      movie(5, 'Tenet'),
      movie(6, 'Up'),
    ]);
    // Fargo and Tenet keep coming back; only Fargo has been around for weeks
    await recordSuggestions(user, [movie(4, 'Fargo'), movie(5, 'Tenet')]);
    await age(user, 'Fargo', 20);
    // Up was in one list long ago and never again
    await age(user, 'Up', 90);

    await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: '',
        mediaType: MediaType.MOVIE,
        title: 'Heat',
        tmdbId: 2,
        requestedBy: user,
      })
    );
    const feedback = [
      new TitleFeedback({
        user,
        tmdbId: 3,
        mediaType: MediaType.MOVIE,
        status: FeedbackStatus.DISLIKED,
        title: 'Alien',
      }),
    ];

    const result = await updateSuggestionOutcomes(user, {
      feedback,
      isWatched: (suggestion) => suggestion.tmdbId === 1,
    });

    const saved = await suggestionsOf(user);
    assert.equal(saved.get('Inception')?.outcome, SuggestionOutcome.WATCHED);
    assert.equal(saved.get('Heat')?.outcome, SuggestionOutcome.REQUESTED);
    assert.equal(saved.get('Alien')?.outcome, SuggestionOutcome.DISLIKED);
    assert.equal(saved.get('Fargo')?.outcome, SuggestionOutcome.SKIPPED);
    assert.equal(saved.get('Tenet')?.outcome, SuggestionOutcome.PENDING);
    assert.equal(saved.has('Up'), false);

    assert.deepEqual(result.pickedUp.map((item) => item.title).sort(), [
      'Heat',
      'Inception',
    ]);
    assert.deepEqual(
      result.passedOn.map((item) => item.title),
      ['Fargo']
    );
  });

  it('counts a skipped pick that gets watched later', async () => {
    const user = await getUser();

    await recordSuggestions(user, [movie(4, 'Fargo')]);
    await recordSuggestions(user, [movie(4, 'Fargo')]);
    await age(user, 'Fargo', 20);
    await updateSuggestionOutcomes(user, {
      feedback: [],
      isWatched: () => false,
    });
    assert.equal(
      (await suggestionsOf(user)).get('Fargo')?.outcome,
      SuggestionOutcome.SKIPPED
    );

    const result = await updateSuggestionOutcomes(user, {
      feedback: [],
      isWatched: (suggestion) => suggestion.tmdbId === 4,
    });
    assert.equal(
      (await suggestionsOf(user)).get('Fargo')?.outcome,
      SuggestionOutcome.WATCHED
    );
    assert.equal(result.passedOn.length, 0);
  });

  it('turns a watched pick into disliked when rated down later', async () => {
    const user = await getUser();
    await recordSuggestions(user, [movie(1, 'Inception'), movie(2, 'Heat')]);
    const watched = (suggestion: AiSuggestion) =>
      suggestion.tmdbId === 1 || suggestion.tmdbId === 2;
    await updateSuggestionOutcomes(user, { feedback: [], isWatched: watched });

    const rating = (tmdbId: number, title: string, status: FeedbackStatus) =>
      new TitleFeedback({
        user,
        tmdbId,
        mediaType: MediaType.MOVIE,
        status,
        title,
      });
    const result = await updateSuggestionOutcomes(user, {
      feedback: [
        rating(1, 'Inception', FeedbackStatus.DISLIKED),
        rating(2, 'Heat', FeedbackStatus.MEH),
      ],
      // Even if the media server history can't be read this time
      isWatched: () => false,
    });

    const saved = await suggestionsOf(user);
    assert.equal(saved.get('Inception')?.outcome, SuggestionOutcome.DISLIKED);
    // Just OK still counts as watched; the rating is shown to the AI
    assert.equal(saved.get('Heat')?.outcome, SuggestionOutcome.WATCHED);
    assert.deepEqual(
      result.pickedUp.map((item) => item.title),
      ['Heat']
    );
  });
});

const emptyProfile = (): TasteProfile => ({
  liked: [],
  meh: [],
  disliked: [],
  watched: [],
  seenElsewhere: [],
  requested: [],
  watchlist: [],
  pickedUp: [],
  passedOn: [],
});

describe('AI taste profile', () => {
  it('lists titles rated "it was OK" on their own', () => {
    const profile = emptyProfile();
    profile.meh.push({ title: 'Tenet', type: 'movie', year: 2020 });
    profile.pickedUp.push({
      title: 'Heat',
      type: 'movie',
      outcome: SuggestionOutcome.WATCHED,
      rating: FeedbackStatus.MEH,
    });

    const text = formatTasteProfile(profile);
    assert.match(text, /Rated "it was OK".*\n- Tenet \(2020\) \| movie/);
    assert.match(text, /Heat \| movie \| they watched it, it was just OK/);
  });

  it('only says "because" for titles from their history', () => {
    const profile = emptyProfile();
    profile.liked.push({ title: 'Alien', type: 'movie' });
    profile.watched.push(
      { title: 'Alien', type: 'movie' },
      { title: 'Dark', type: 'tv' }
    );
    profile.watchlist.push({ title: 'Severance', type: 'tv' });
    profile.disliked.push({ title: 'Cats', type: 'movie' });
    profile.meh.push({ title: 'Tenet', type: 'movie' });
    // Disliked titles never count, even when they're also on the watchlist
    profile.watchlist.push({ title: 'Cats', type: 'movie' });

    const find = basedOnFinder(profile);
    assert.deepEqual(find('alien (1979)'), { title: 'Alien', why: 'loved' });
    assert.deepEqual(find('Dark'), { title: 'Dark', why: 'watched' });
    assert.deepEqual(find('Severance'), {
      title: 'Severance',
      why: 'watchlist',
    });
    assert.equal(find('Cats'), undefined);
    assert.equal(find('Tenet'), undefined);
    assert.equal(find('Something they never saw'), undefined);
    assert.equal(find(null), undefined);
  });
});

describe('Claude Code output', () => {
  it('returns the answer text', () => {
    assert.equal(
      readClaudeCodeOutput({
        stdout: JSON.stringify({ is_error: false, result: '{"ok":true}' }),
        stderr: '',
        code: 0,
      }),
      '{"ok":true}'
    );
  });

  it('explains a missing sign-in', () => {
    assert.throws(
      () =>
        readClaudeCodeOutput({
          stdout: JSON.stringify({
            is_error: true,
            result: 'Not logged in · Please run /login',
          }),
          stderr: '',
          code: 1,
        }),
      /isn't signed in on the server/
    );
  });

  it('reports other failures', () => {
    assert.throws(
      () => readClaudeCodeOutput({ stdout: '', stderr: 'boom', code: 2 }),
      /Claude Code failed \(exit code 2\): boom/
    );
  });
});
