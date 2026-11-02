import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import type { AiProvider, AiSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsAi', {
  ai: 'AI Recommendations',
  aiSettings: 'AI Recommendations',
  aiSettingsDescription:
    'Show each user a "Recommended for You" row on the Discover page, picked by an AI model from their watch history, requests and watchlist. Recommendations are cached per user to limit API usage.',
  privacyNotice:
    "Each user's watch history, requests and watchlist titles are sent to the selected AI provider. Use a local model through the OpenAI-compatible provider to keep this data on your own hardware.",
  enabled: 'Enable AI Recommendations',
  provider: 'Provider',
  providerAnthropic: 'Claude (Anthropic)',
  providerOpenai: 'OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter)',
  providerGemini: 'Google Gemini',
  apiKey: 'API Key',
  apiKeyTipOpenai: 'Leave empty for local servers that need no key',
  model: 'Model',
  modelTipAnthropic:
    'Claude Opus 5.5 is the default. Claude Haiku 5.5 (claude-haiku-5-5) costs much less per request.',
  modelTipOpenai:
    'The model name your server expects, e.g. llama3.1 for Ollama',
  modelTipGemini: 'The model ID shown in Google AI Studio',
  baseUrl: 'Base URL',
  baseUrlTip:
    'Leave empty for OpenAI. For Ollama use http://localhost:11434/v1, for LM Studio http://localhost:1234/v1.',
  cacheHours: 'Refresh Every (Hours)',
  cacheHoursTip:
    'How long a user keeps the same recommendations before the AI is asked again',
  chatEnabled: 'Enable Ask AI Chat',
  chatEnabledTip:
    'Adds an "Ask AI" page where users can ask things like "what should I watch tonight?". Limited to 40 messages per user per hour.',
  chatModel: 'Chat Model',
  chatModelTipAnthropic:
    'Leave empty to use Claude Haiku 5.5, the cheapest Claude model (about a tenth of a cent per message)',
  chatModelTipOther: 'Leave empty to use the same model as recommendations',
  validationApiKey: 'You must provide an API key',
  validationModel: 'You must provide a model',
  validationCacheHours: 'You must provide a number of hours between 1 and 720',
  toastSaveSuccess: 'AI recommendation settings saved successfully!',
  toastSaveFailure:
    'Something went wrong while saving AI recommendation settings.',
  toastTestSending: 'Asking the AI for recommendations…',
  toastTestSuccess:
    'Got {count} recommendations, for example: {titles}. These are based on your own history.',
  toastTestEmpty:
    'The AI responded, but there were no recommendations. Watch, request or watchlist a few titles first.',
  toastTestFailure: 'Test failed: {error}',
});

const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: '',
  gemini: '',
};

const SettingsAi = () => {
  const intl = useIntl();
  const { addToast, removeToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<AiSettings>('/api/v1/settings/ai');

  const AiSettingsSchema = Yup.object().shape({
    provider: Yup.string().oneOf(['anthropic', 'openai', 'gemini']),
    apiKey: Yup.string().when(['enabled', 'provider'], {
      is: (enabled: boolean, provider: AiProvider) =>
        enabled && provider !== 'openai',
      then: (schema) =>
        schema.required(intl.formatMessage(messages.validationApiKey)),
    }),
    model: Yup.string().when(['enabled', 'provider'], {
      is: (enabled: boolean, provider: AiProvider) =>
        enabled && provider !== 'anthropic',
      then: (schema) =>
        schema.required(intl.formatMessage(messages.validationModel)),
    }),
    cacheHours: Yup.number()
      .typeError(intl.formatMessage(messages.validationCacheHours))
      .integer(intl.formatMessage(messages.validationCacheHours))
      .min(1, intl.formatMessage(messages.validationCacheHours))
      .max(720, intl.formatMessage(messages.validationCacheHours))
      .required(intl.formatMessage(messages.validationCacheHours)),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.ai),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.aiSettings)}</h3>
        <p className="description">
          {intl.formatMessage(messages.aiSettingsDescription)}
        </p>
      </div>
      <Alert title={intl.formatMessage(messages.privacyNotice)} type="info" />
      <Formik
        initialValues={{
          enabled: data?.enabled ?? false,
          provider: data?.provider ?? ('anthropic' as AiProvider),
          apiKey: data?.apiKey ?? '',
          model: data?.model ?? DEFAULT_MODELS.anthropic,
          baseUrl: data?.baseUrl ?? '',
          cacheHours: data?.cacheHours ?? 24,
          chatEnabled: data?.chatEnabled ?? true,
          chatModel: data?.chatModel ?? '',
        }}
        enableReinitialize
        validationSchema={AiSettingsSchema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/ai', {
              ...values,
              cacheHours: Number(values.cacheHours),
            } as AiSettings);
            addToast(intl.formatMessage(messages.toastSaveSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSaveFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
            mutate('/api/v1/settings/public');
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
        }) => {
          const testSettings = async () => {
            setIsTesting(true);
            let toastId: string | undefined;
            try {
              addToast(
                intl.formatMessage(messages.toastTestSending),
                { autoDismiss: false, appearance: 'info' },
                (id) => {
                  toastId = id;
                }
              );
              const response = await axios.post<{
                count: number;
                titles: string[];
              }>('/api/v1/settings/ai/test', {
                ...values,
                enabled: true,
                cacheHours: Number(values.cacheHours),
              });
              if (toastId) {
                removeToast(toastId);
              }
              addToast(
                response.data.count > 0
                  ? intl.formatMessage(messages.toastTestSuccess, {
                      count: response.data.count,
                      titles: response.data.titles.join(', '),
                    })
                  : intl.formatMessage(messages.toastTestEmpty),
                {
                  autoDismiss: true,
                  appearance: response.data.count > 0 ? 'success' : 'warning',
                }
              );
            } catch (e) {
              if (toastId) {
                removeToast(toastId);
              }
              addToast(
                intl.formatMessage(messages.toastTestFailure, {
                  error: e.response?.data?.message ?? e.message,
                }),
                { autoDismiss: true, appearance: 'error' }
              );
            } finally {
              setIsTesting(false);
            }
          };

          const modelTip = {
            anthropic: messages.modelTipAnthropic,
            openai: messages.modelTipOpenai,
            gemini: messages.modelTipGemini,
          }[values.provider];

          return (
            <form className="section" onSubmit={handleSubmit}>
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  {intl.formatMessage(messages.enabled)}
                </label>
                <div className="form-input-area">
                  <Field type="checkbox" id="enabled" name="enabled" />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="provider" className="text-label">
                  {intl.formatMessage(messages.provider)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="provider"
                      name="provider"
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                        const provider = e.target.value as AiProvider;
                        // Swap in the new provider's default unless the admin
                        // typed a model of their own
                        if (
                          Object.values(DEFAULT_MODELS).includes(values.model)
                        ) {
                          setFieldValue('model', DEFAULT_MODELS[provider]);
                        }
                        setFieldValue('provider', provider);
                      }}
                    >
                      <option value="anthropic">
                        {intl.formatMessage(messages.providerAnthropic)}
                      </option>
                      <option value="openai">
                        {intl.formatMessage(messages.providerOpenai)}
                      </option>
                      <option value="gemini">
                        {intl.formatMessage(messages.providerGemini)}
                      </option>
                    </Field>
                  </div>
                </div>
              </div>
              {values.provider === 'openai' && (
                <div className="form-row">
                  <label htmlFor="baseUrl" className="text-label">
                    {intl.formatMessage(messages.baseUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.baseUrlTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="text"
                        inputMode="url"
                        id="baseUrl"
                        name="baseUrl"
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                  </div>
                </div>
              )}
              <div className="form-row">
                <label htmlFor="apiKey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  {values.provider !== 'openai' && (
                    <span className="label-required">*</span>
                  )}
                  {values.provider === 'openai' && (
                    <span className="label-tip">
                      {intl.formatMessage(messages.apiKeyTipOpenai)}
                    </span>
                  )}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="apiKey"
                      name="apiKey"
                      autoComplete="off"
                    />
                  </div>
                  {errors.apiKey &&
                    touched.apiKey &&
                    typeof errors.apiKey === 'string' && (
                      <div className="error">{errors.apiKey}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="model" className="text-label">
                  {intl.formatMessage(messages.model)}
                  {values.provider !== 'anthropic' && (
                    <span className="label-required">*</span>
                  )}
                  <span className="label-tip">
                    {intl.formatMessage(modelTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      id="model"
                      name="model"
                      placeholder={DEFAULT_MODELS[values.provider]}
                    />
                  </div>
                  {errors.model &&
                    touched.model &&
                    typeof errors.model === 'string' && (
                      <div className="error">{errors.model}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="cacheHours" className="text-label">
                  {intl.formatMessage(messages.cacheHours)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.cacheHoursTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="text"
                    inputMode="numeric"
                    id="cacheHours"
                    name="cacheHours"
                    className="short"
                  />
                  {errors.cacheHours &&
                    touched.cacheHours &&
                    typeof errors.cacheHours === 'string' && (
                      <div className="error">{errors.cacheHours}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="chatEnabled" className="checkbox-label">
                  {intl.formatMessage(messages.chatEnabled)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.chatEnabledTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field type="checkbox" id="chatEnabled" name="chatEnabled" />
                </div>
              </div>
              {values.chatEnabled && (
                <div className="form-row">
                  <label htmlFor="chatModel" className="text-label">
                    {intl.formatMessage(messages.chatModel)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        values.provider === 'anthropic'
                          ? messages.chatModelTipAnthropic
                          : messages.chatModelTipOther
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="text"
                        id="chatModel"
                        name="chatModel"
                        placeholder={
                          values.provider === 'anthropic'
                            ? 'claude-haiku-5-5'
                            : values.model
                        }
                      />
                    </div>
                  </div>
                </div>
              )}
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="warning"
                      disabled={isSubmitting || !isValid || isTesting}
                      onClick={(e) => {
                        e.preventDefault();
                        testSettings();
                      }}
                    >
                      <BeakerIcon />
                      <span>
                        {isTesting
                          ? intl.formatMessage(globalMessages.testing)
                          : intl.formatMessage(globalMessages.test)}
                      </span>
                    </Button>
                  </span>
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid || isTesting}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </form>
          );
        }}
      </Formik>
    </>
  );
};

export default SettingsAi;
