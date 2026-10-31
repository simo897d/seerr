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

const askOpenAiCompatible = async (
  settings: AiSettings,
  system: string,
  prompt: string
): Promise<string> => {
  const baseUrl = (settings.baseUrl || 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  );

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: settings.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
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
  prompt: string
): Promise<string> => {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      settings.model
    )}:generateContent`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

const parseJsonRecommendations = (text: string): AiRecommendation[] => {
  // Some local models wrap JSON in a markdown code fence
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new Error('The AI response was not valid JSON');
  }

  // Accept a bare array as well as { recommendations: [...] }
  const parsed = LooseRecommendationListSchema.safeParse(
    Array.isArray(json) ? { recommendations: json } : json
  );

  if (!parsed.success) {
    throw new Error('The AI response did not match the expected format');
  }

  return parsed.data.recommendations;
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
        await askOpenAiCompatible(settings, system, prompt)
      );
    case 'gemini':
      return parseJsonRecommendations(
        await askGemini(settings, system, prompt)
      );
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
};
