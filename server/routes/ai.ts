import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { ChatLimitError, chatWithAi } from '@server/lib/ai/chat';
import type { ChatTurn } from '@server/lib/ai/providers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { Router } from 'express';

const aiRoutes = Router();

aiRoutes.post<never, unknown, { messages: ChatTurn[] }>(
  '/chat',
  async (req, res, next) => {
    const settings = getSettings().ai;

    if (!settings.enabled || settings.chatEnabled === false) {
      return next({ status: 404, message: 'AI chat is not enabled.' });
    }
    if (!req.user) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    try {
      const answer = await chatWithAi(req.user, req.body.messages);

      const media = await Media.getRelatedMedia(
        req.user,
        answer.titles.map((item) => ({
          tmdbId: item.result.id,
          mediaType:
            item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
        })),
        { includeActiveRequest: true }
      );

      return res.status(200).json({
        reply: answer.reply,
        results: answer.titles.map((item) => {
          const type =
            item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
          const selectedMedia = media.find(
            (med) => med.tmdbId === item.result.id && med.mediaType === type
          );
          return item.mediaType === 'movie'
            ? mapMovieResult(item.result, selectedMedia)
            : mapTvResult(item.result, selectedMedia);
        }),
      });
    } catch (e) {
      if (e instanceof ChatLimitError) {
        return next({ status: 429, message: e.message });
      }
      logger.error('Something went wrong answering an AI chat message', {
        label: 'AI Recommendations',
        userId: req.user.id,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'The AI could not answer right now. Please try again.',
      });
    }
  }
);

export default aiRoutes;
