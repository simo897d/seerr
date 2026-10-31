import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { FeedbackStatus } from '@server/entity/TitleFeedback';
import { TitleFeedback } from '@server/entity/TitleFeedback';
import { getUserFeedback } from '@server/lib/ai/recommendations';
import logger from '@server/logger';
import { Router } from 'express';

// Lets users tell the AI what they've seen elsewhere and what they thought of it
const feedbackRoutes = Router();

type TitleParams = { mediaType: string; tmdbId: string };

const parseParams = ({ mediaType, tmdbId }: TitleParams) => ({
  mediaType: mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
  tmdbId: Number(tmdbId),
});

const toResponse = (item: TitleFeedback) => ({
  tmdbId: item.tmdbId,
  mediaType: item.mediaType,
  status: item.status,
  title: item.title,
  year: item.year ?? undefined,
  updatedAt: item.updatedAt,
});

feedbackRoutes.get('/', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Unauthorized' });
  }

  try {
    const feedback = await getUserFeedback(req.user);
    return res.status(200).json(feedback.map(toResponse));
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

feedbackRoutes.get<TitleParams>(
  '/:mediaType/:tmdbId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    try {
      const feedback = await getRepository(TitleFeedback).findOne({
        where: { user: { id: req.user.id }, ...parseParams(req.params) },
      });
      return res.status(200).json({ status: feedback?.status ?? null });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

feedbackRoutes.post<TitleParams, unknown, { status: FeedbackStatus }>(
  '/:mediaType/:tmdbId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const { mediaType, tmdbId } = parseParams(req.params);
    const repository = getRepository(TitleFeedback);

    try {
      // Store the English title and year, since that's what the AI is given
      const tmdb = new TheMovieDb();
      let title: string;
      let year: number | undefined;
      if (mediaType === MediaType.MOVIE) {
        const movie = await tmdb.getMovie({ movieId: tmdbId });
        title = movie.title;
        year = parseInt(movie.release_date?.slice(0, 4) ?? '', 10);
      } else {
        const show = await tmdb.getTvShow({ tvId: tmdbId });
        title = show.name;
        year = parseInt(show.first_air_date?.slice(0, 4) ?? '', 10);
      }

      const feedback =
        (await repository.findOne({
          where: { user: { id: req.user.id }, mediaType, tmdbId },
        })) ?? new TitleFeedback({ user: req.user, mediaType, tmdbId });

      feedback.status = req.body.status;
      feedback.title = title;
      feedback.year = Number.isFinite(year) ? year : null;

      const saved = await repository.save(feedback);
      return res.status(200).json(toResponse(saved));
    } catch (e) {
      logger.error('Could not save title feedback', {
        label: 'AI Recommendations',
        userId: req.user.id,
        mediaType,
        tmdbId,
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to save feedback.' });
    }
  }
);

feedbackRoutes.delete<TitleParams>(
  '/:mediaType/:tmdbId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    try {
      await getRepository(TitleFeedback).delete({
        user: { id: req.user.id },
        ...parseParams(req.params),
      });
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

export default feedbackRoutes;
