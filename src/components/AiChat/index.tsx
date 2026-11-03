import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useAiEnabled from '@app/hooks/useAiEnabled';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  PaperAirplaneIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.AiChat', {
  askAi: 'Ask AI',
  intro:
    'Ask for ideas based on what you like and what is on the server. Ratings you give on title pages make the answers better.',
  placeholder: 'What should I watch tonight?',
  send: 'Send',
  newChat: 'New Chat',
  thinking: 'Thinking…',
  you: 'You',
  error: 'Something went wrong. Please try again.',
  notEnabled:
    'AI chat is turned off. An admin can enable it under Settings → AI.',
  suggestionTonight: 'What should I watch tonight?',
  suggestionShort: 'Something funny and under 2 hours',
  suggestionSeries: 'A series to binge this weekend',
  suggestionFamily: 'A movie the whole family will like',
});

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  results?: (MovieResult | TvResult)[];
}

const STORAGE_KEY = 'ai-chat-messages';

// Keep the conversation if the user opens a title and comes back
const loadSaved = (): ChatMessage[] => {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
};

const save = (chat: ChatMessage[]) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(chat));
  } catch {
    // Storage can be unavailable (private mode); the chat still works
  }
};

const TitleRow = ({
  sliderKey,
  results,
}: {
  sliderKey: string;
  results: (MovieResult | TvResult)[];
}) => (
  <div className="mt-3">
    <Slider
      sliderKey={sliderKey}
      isLoading={false}
      items={results.map((title) => (
        <TitleCard
          key={`${title.mediaType}-${title.id}`}
          id={title.id}
          isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
          image={title.posterPath}
          status={title.mediaInfo?.status}
          summary={title.overview}
          title={title.mediaType === 'movie' ? title.title : title.name}
          userScore={title.voteAverage}
          year={
            title.mediaType === 'movie' ? title.releaseDate : title.firstAirDate
          }
          mediaType={title.mediaType}
          inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
        />
      ))}
    />
  </div>
);

const AiChat = () => {
  const intl = useIntl();
  const aiEnabled = useAiEnabled();
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChat(loadSaved());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat, isSending]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isSending) {
      return;
    }

    const next: ChatMessage[] = [...chat, { role: 'user', content }];
    setChat(next);
    save(next);
    setInput('');
    setError(null);
    setIsSending(true);

    try {
      const response = await axios.post<{
        reply: string;
        results: (MovieResult | TvResult)[];
      }>('/api/v1/ai/chat', {
        // Only text goes back to the server; posters stay in the browser
        messages: next.map(({ role, content }) => ({ role, content })),
      });
      const withReply: ChatMessage[] = [
        ...next,
        {
          role: 'assistant',
          content: response.data.reply,
          results: response.data.results,
        },
      ];
      setChat(withReply);
      save(withReply);
    } catch (e) {
      setError(e.response?.data?.message ?? intl.formatMessage(messages.error));
    } finally {
      setIsSending(false);
    }
  };

  const reset = () => {
    setChat([]);
    save([]);
    setError(null);
  };

  if (!aiEnabled.chat) {
    return (
      <>
        <PageTitle title={intl.formatMessage(messages.askAi)} />
        <p className="mt-8 text-gray-400">
          {intl.formatMessage(messages.notEnabled)}
        </p>
      </>
    );
  }

  const suggestions = [
    messages.suggestionTonight,
    messages.suggestionShort,
    messages.suggestionSeries,
    messages.suggestionFamily,
  ];

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.askAi)} />
      <div className="mt-6 flex items-center justify-between gap-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <SparklesIcon className="h-7 w-7 text-indigo-400" />
          {intl.formatMessage(messages.askAi)}
        </h1>
        {chat.length > 0 && (
          <Button buttonSize="sm" buttonType="ghost" onClick={reset}>
            <ArrowPathIcon />
            <span>{intl.formatMessage(messages.newChat)}</span>
          </Button>
        )}
      </div>

      <div className="mt-6 space-y-6 pb-4">
        {chat.length === 0 && (
          <div>
            <p className="text-gray-400">
              {intl.formatMessage(messages.intro)}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion.id}
                  buttonSize="sm"
                  buttonType="ghost"
                  onClick={() => send(intl.formatMessage(suggestion))}
                >
                  {intl.formatMessage(suggestion)}
                </Button>
              ))}
            </div>
          </div>
        )}

        {chat.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-indigo-600 px-4 py-2 text-white">
                {message.content}
              </div>
            </div>
          ) : (
            <div key={index}>
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-800 px-4 py-2 text-gray-100 ring-1 ring-gray-700">
                {message.content}
              </div>
              {!!message.results?.length && (
                <TitleRow
                  sliderKey={`ai-chat-${index}`}
                  results={message.results}
                />
              )}
            </div>
          )
        )}

        {isSending && (
          <div className="flex items-center gap-2 text-gray-400">
            <SparklesIcon className="h-5 w-5 animate-pulse" />
            <span>{intl.formatMessage(messages.thinking)}</span>
          </div>
        )}
        {error && <p className="text-red-400">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        className="sticky bottom-20 z-10 flex gap-2 rounded-lg bg-gray-900 py-2 sm:bottom-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          type="text"
          className="flex-1"
          value={input}
          maxLength={1500}
          placeholder={intl.formatMessage(messages.placeholder)}
          aria-label={intl.formatMessage(messages.placeholder)}
          onChange={(e) => setInput(e.target.value)}
          disabled={isSending}
        />
        <Button
          type="submit"
          buttonType="primary"
          disabled={isSending || !input.trim()}
        >
          <PaperAirplaneIcon />
          <span className="hidden sm:inline">
            {intl.formatMessage(messages.send)}
          </span>
        </Button>
      </form>
    </>
  );
};

export default AiChat;
