import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AiSettings } from '@server/lib/settings';
import axios from 'axios';
import { z } from 'zod';

export const RecommendationListSchema = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      year: z.number().int().nullable(),
      mediaType: z.enum(['movie', 'tv']),
      reason: z.string(),
    })
  ),
});

export type AiRecommendation = z.infer<
  typeof RecommendationListSchema
>['recommendations'][number];

export const ChatReplySchema = z.object({
  reply: z.string(),
  titles: z.array(
    z.object({
      title: z.string(),
      year: z.number().int().nullable(),
      mediaType: z.enum(['movie', 'tv']),
    })
  ),
});

export type ChatReply = z.infer<typeof ChatReplySchema>;

// Other providers don't enforce a schema, so accept common variations
// (year as a string, missing reason) and normalize them.
const LooseRecommendationListSchema = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      year: z
        .union([z.number(), z.string(), z.null()])
        .optional()
        .transform((year) => {
          const parsed = parseInt(String(year ?? ''), 10);
          return Number.isFinite(parsed) ? parsed : null;
        }),
      mediaType: z
        .string()
        .transform((type) =>
          /tv|series|show/i.test(type) ? ('tv' as const) : ('movie' as const)
        ),
      reason: z.string().optional().default(''),
    })
  ),
});

const REQUEST_TIMEOUT_MS = 180_000;

// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

// Older Claude models reject the `effort` parameter.
const supportsEffort = (model: string) =>
  !/^claude-(3|haiku-4|sonnet-4-5|opus-4-[0-5]\b)/.test(model);

const askAnthropic = async (
  settings: AiSettings,
  system: string,
  prompt: string
): Promise<AiRecommendation[]> => {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const model = settings.model || 'claude-opus-5-5';
  const useFallback = FALLBACK_MODELS.has(model);

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
      format: betaZodOutputFormat(RecommendationListSchema),
    },
    ...(useFallback
      ? {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }
      : {}),
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined the request${
        response.stop_details?.category
          ? ` (${response.stop_details.category})`
          : ''
      }`
    );
  }

  if (!response.parsed_output) {
    throw new Error(
      `Claude returned no usable recommendations (stop reason: ${response.stop_reason})`
    );
  }

  return response.parsed_output.recommendations;
};

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const askOpenAiCompatible = async (
  settings: AiSettings,
  system: string,
  turns: ChatTurn[],
  model = settings.model
): Promise<string> => {
  const baseUrl = (settings.baseUrl || 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  );

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'system', content: system }, ...turns],
      response_format: { type: 'json_object' },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: settings.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : {},
    }
  );

  return response.data?.choices?.[0]?.message?.content ?? '';
};

const askGemini = async (
  settings: AiSettings,
  system: string,
  turns: ChatTurn[],
  model = settings.model
): Promise<string> => {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      })),
      generationConfig: { responseMimeType: 'application/json' },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'x-goog-api-key': settings.apiKey },
    }
  );

  const parts: { text?: string }[] =
    response.data?.candidates?.[0]?.content?.parts ?? [];

  return parts.map((part) => part.text ?? '').join('');
};

const parseJson = (text: string): unknown => {
  // Some local models wrap JSON in a markdown code fence
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('The AI response was not valid JSON');
  }
};

const parseJsonRecommendations = (text: string): AiRecommendation[] => {
  const json = parseJson(text);

  // Accept a bare array as well as { recommendations: [...] }
  const parsed = LooseRecommendationListSchema.safeParse(
    Array.isArray(json) ? { recommendations: json } : json
  );

  if (!parsed.success) {
    throw new Error('The AI response did not match the expected format');
  }

  return parsed.data.recommendations;
};

export interface AiModelOption {
  id: string;
  name: string;
}

// Shown before an API key is entered, and if listing fails
export const KNOWN_CLAUDE_MODELS: AiModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];

/** Asks the provider which models this API key can use. */
export const listModels = async ({
  provider,
  apiKey,
  baseUrl,
}: Pick<AiSettings, 'provider' | 'apiKey' | 'baseUrl'>): Promise<
  AiModelOption[]
> => {
  switch (provider) {
    case 'anthropic': {
      const client = new Anthropic({ apiKey, timeout: 15_000 });
      const models: AiModelOption[] = [];
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({ id: model.id, name: model.display_name });
      }
      return models;
    }
    case 'openai': {
      const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const response = await axios.get<{ data?: { id: string }[] }>(
        `${url}/models`,
        {
          timeout: 15_000,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        }
      );
      return (response.data.data ?? [])
        .map((model) => ({ id: model.id, name: model.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case 'gemini': {
      const response = await axios.get<{
        models?: {
          name: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }[];
      }>('https://generativelanguage.googleapis.com/v1beta/models', {
        timeout: 15_000,
        params: { pageSize: 1000 },
        headers: { 'x-goog-api-key': apiKey },
      });
      // Only models that can write text replies
      return (response.data.models ?? [])
        .filter((model) =>
          model.supportedGenerationMethods?.includes('generateContent')
        )
        .map((model) => {
          const id = model.name.replace(/^models\//, '');
          return { id, name: model.displayName ?? id };
        });
    }
    default:
      return [];
  }
};

// The cheapest current Claude model; chat replies are short and frequent
export const DEFAULT_CLAUDE_CHAT_MODEL = 'claude-haiku-5-5';

const chatAnthropic = async (
  settings: AiSettings,
  system: string,
  turns: ChatTurn[]
): Promise<ChatReply> => {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const model = settings.chatModel || DEFAULT_CLAUDE_CHAT_MODEL;
  const useFallback = FALLBACK_MODELS.has(model);

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 4000,
    system,
    messages: turns,
    // The system prompt (taste profile, library) and earlier turns repeat on
    // every message, so let the API cache them
    cache_control: { type: 'ephemeral' },
    output_config: {
      ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
      format: betaZodOutputFormat(ChatReplySchema),
    },
    ...(useFallback
      ? {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }
      : {}),
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer that');
  }

  if (!response.parsed_output) {
    throw new Error(
      `Claude returned no usable reply (stop reason: ${response.stop_reason})`
    );
  }

  return response.parsed_output;
};

const LooseChatReplySchema = z.object({
  reply: z.string(),
  titles: z
    .array(
      LooseRecommendationListSchema.shape.recommendations.element.omit({
        reason: true,
      })
    )
    .optional()
    .default([]),
});

/**
 * Sends a short conversation to the configured provider and returns its
 * reply plus any titles it mentions. Uses `chatModel` when set, so chat can
 * run on a cheaper model than the recommendations.
 */
export const askForChatReply = async (
  settings: AiSettings,
  system: string,
  turns: ChatTurn[]
): Promise<ChatReply> => {
  const model = settings.chatModel || settings.model;

  if (!model && settings.provider !== 'anthropic') {
    throw new Error('No AI model is configured');
  }

  const parseLoose = (text: string) => {
    const parsed = LooseChatReplySchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new Error('The AI response did not match the expected format');
    }
    return parsed.data;
  };

  switch (settings.provider) {
    case 'anthropic':
      return chatAnthropic(settings, system, turns);
    case 'openai':
      return parseLoose(
        await askOpenAiCompatible(settings, system, turns, model)
      );
    case 'gemini':
      return parseLoose(await askGemini(settings, system, turns, model));
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
};

export const askForRecommendations = async (
  settings: AiSettings,
  system: string,
  prompt: string
): Promise<AiRecommendation[]> => {
  if (!settings.model && settings.provider !== 'anthropic') {
    throw new Error('No AI model is configured');
  }

  switch (settings.provider) {
    case 'anthropic':
      return askAnthropic(settings, system, prompt);
    case 'openai':
      return parseJsonRecommendations(
        await askOpenAiCompatible(settings, system, [
          { role: 'user', content: prompt },
        ])
      );
    case 'gemini':
      return parseJsonRecommendations(
        await askGemini(settings, system, [{ role: 'user', content: prompt }])
      );
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
};
