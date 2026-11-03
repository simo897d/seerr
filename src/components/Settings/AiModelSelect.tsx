import defineMessages from '@app/utils/defineMessages';
import type { AiProvider } from '@server/lib/settings';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.AiModelSelect', {
  loading: 'Loading models…',
  needKey: 'Enter your API key to see the available models.',
  loadFailed: "Couldn't load the model list: {error}",
  other: 'Other…',
  customPlaceholder: 'Model ID',
  claudeCodeFound: 'Found {version} on the server.',
  claudeCodeNoToken:
    "CLAUDE_CODE_OAUTH_TOKEN isn't set for Seerr's service, so Claude Code needs its own sign-in on the server. Press Test to check.",
});

interface ClaudeCodeStatus {
  version: string;
  tokenSet: boolean;
}

export interface AiModelOption {
  id: string;
  name: string;
}

// Shown for Claude before a key is entered or if the list can't be loaded
const KNOWN_CLAUDE_MODELS: AiModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];

interface ModelList {
  models: AiModelOption[];
  status: 'idle' | 'loading' | 'loaded' | 'needKey' | 'error';
  error?: string;
  claudeCode?: ClaudeCodeStatus;
}

/**
 * Asks the server which models the provider offers for this key. Waits a
 * moment after typing stops before asking.
 */
export const useAiModels = (
  provider: AiProvider,
  apiKey: string,
  baseUrl: string
): ModelList => {
  const [list, setList] = useState<ModelList>({ models: [], status: 'idle' });

  useEffect(() => {
    const fallback =
      provider === 'anthropic' || provider === 'claude-code'
        ? KNOWN_CLAUDE_MODELS
        : [];

    // Local OpenAI-compatible servers (Ollama, LM Studio) need no key, and
    // Claude Code signs in on its own
    if (!apiKey && (provider === 'anthropic' || provider === 'gemini')) {
      setList({ models: fallback, status: 'needKey' });
      return;
    }

    let cancelled = false;
    setList({ models: fallback, status: 'loading' });
    const timeout = setTimeout(async () => {
      try {
        const response = await axios.post<{
          models: AiModelOption[];
          claudeCode?: ClaudeCodeStatus;
        }>('/api/v1/settings/ai/models', { provider, apiKey, baseUrl });
        if (!cancelled) {
          setList({
            models: response.data.models.length
              ? response.data.models
              : fallback,
            status: 'loaded',
            claudeCode: response.data.claudeCode,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setList({
            models: fallback,
            status: 'error',
            error: e.response?.data?.message ?? e.message,
          });
        }
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [provider, apiKey, baseUrl]);

  return list;
};

const CUSTOM = '__custom__';

interface AiModelSelectProps {
  id: string;
  value: string;
  onChange: (model: string) => void;
  list: ModelList;
  // Adds a first option for "no specific model", e.g. "Default (Claude Haiku 5.5)"
  emptyLabel?: string;
  // Hide the status line, e.g. when another picker above already shows it
  hideStatus?: boolean;
}

const AiModelSelect = ({
  id,
  value,
  onChange,
  list,
  emptyLabel,
  hideStatus,
}: AiModelSelectProps) => {
  const intl = useIntl();
  const known = list.models.some((model) => model.id === value);
  const [custom, setCustom] = useState(false);

  // Typing a custom ID that turns out to be listed switches back to the list
  useEffect(() => {
    if (known) {
      setCustom(false);
    }
  }, [known]);

  // A saved model that isn't (or is no longer) listed stays selectable
  const options =
    value && !known
      ? [{ id: value, name: value }, ...list.models]
      : list.models;

  return (
    <>
      <div className="form-input-field">
        <select
          id={id}
          value={custom ? CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
          {!emptyLabel && !value && <option value="" disabled />}
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name === model.id
                ? model.id
                : `${model.name} (${model.id})`}
            </option>
          ))}
          <option value={CUSTOM}>{intl.formatMessage(messages.other)}</option>
        </select>
      </div>
      {custom && (
        <div className="form-input-field mt-2">
          <input
            type="text"
            aria-label={intl.formatMessage(messages.customPlaceholder)}
            placeholder={intl.formatMessage(messages.customPlaceholder)}
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
          />
        </div>
      )}
      {!hideStatus && list.status === 'loading' && (
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.loading)}
        </p>
      )}
      {!hideStatus && list.status === 'needKey' && (
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.needKey)}
        </p>
      )}
      {!hideStatus && list.claudeCode && (
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.claudeCodeFound, {
            version: list.claudeCode.version,
          })}
          {!list.claudeCode.tokenSet &&
            ` ${intl.formatMessage(messages.claudeCodeNoToken)}`}
        </p>
      )}
      {!hideStatus && list.status === 'error' && (
        <p className="mt-1 text-sm text-red-400">
          {intl.formatMessage(messages.loadFailed, { error: list.error })}
        </p>
      )}
    </>
  );
};

export default AiModelSelect;

/** Loads the model list once for several pickers. */
export const AiModelList = ({
  provider,
  apiKey,
  baseUrl,
  children,
}: {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  children: (list: ModelList) => React.ReactNode;
}) => {
  const list = useAiModels(provider, apiKey, baseUrl);
  return <>{children(list)}</>;
};
