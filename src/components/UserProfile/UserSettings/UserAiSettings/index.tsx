import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { UserSettingsAiResponse } from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserAiSettings',
  {
    aiRecommendations: 'AI Recommendations',
    kidsMode: 'Kids Profile',
    kidsModeTip:
      'Only recommend child-friendly titles. Only admins can change this.',
    excludedLibraries: 'Ignore Libraries',
    excludedLibrariesTip:
      'Watch history from these libraries is not used for recommendations, e.g. a kids library you only watch with your children',
    toastSettingsSuccess: 'AI recommendation settings saved successfully!',
    toastSettingsFailure: 'Something went wrong while saving settings.',
    ratings: 'Your Ratings',
    ratingsDescription:
      'Titles you marked as watched, loved or not for you. They are never recommended to you, and your ratings guide what is.',
    noRatings:
      'You have not rated anything yet. Use the buttons under the overview on any movie or series page.',
    watched: 'Watched',
    liked: 'Loved it',
    disliked: 'Not for me',
    remove: 'Remove',
    refresh: 'Get New Recommendations',
    refreshing: 'Asking the AI…',
    toastRefreshSuccess:
      'Your recommendations have been updated. Head to Discover to see them.',
    toastRefreshFailure: 'Something went wrong while getting recommendations.',
  }
);

interface FeedbackItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  status: 'watched' | 'liked' | 'disliked';
  title: string;
  year?: number;
}

const statusBadge: Record<
  FeedbackItem['status'],
  'primary' | 'success' | 'danger'
> = {
  watched: 'primary',
  liked: 'success',
  disliked: 'danger',
};

const UserAiSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user: currentUser, hasPermission } = useUser();
  const { user } = useUser({ id: Number(router.query.userId) });
  const isOwnProfile = !!user && currentUser?.id === user.id;
  const canEditKidsMode = hasPermission(Permission.MANAGE_USERS);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<UserSettingsAiResponse>(
    user ? `/api/v1/user/${user.id}/settings/ai` : null
  );
  // Ratings belong to whoever is logged in, so only show them on your own profile
  const { data: feedback, mutate: revalidateFeedback } = useSWR<FeedbackItem[]>(
    isOwnProfile ? '/api/v1/feedback' : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  const removeFeedback = async (item: FeedbackItem) => {
    await axios.delete(`/api/v1/feedback/${item.mediaType}/${item.tmdbId}`);
    revalidateFeedback();
  };

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      await axios.get('/api/v1/discover/recommended', {
        params: { refresh: true },
      });
      addToast(intl.formatMessage(messages.toastRefreshSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.toastRefreshFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.aiRecommendations),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.aiRecommendations)}
        </h3>
      </div>
      <Formik
        initialValues={{
          kidsMode: data.kidsMode,
          excludedLibraries: data.excludedLibraries,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post(`/api/v1/user/${user?.id}/settings/ai`, {
              ...(canEditKidsMode ? { kidsMode: values.kidsMode } : {}),
              excludedLibraries: values.excludedLibraries,
            });
            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({ isSubmitting, values, setFieldValue }) => (
          <Form className="section">
            <div className="form-row">
              <label htmlFor="kidsMode" className="checkbox-label">
                <span>{intl.formatMessage(messages.kidsMode)}</span>
                <span className="label-tip">
                  {intl.formatMessage(messages.kidsModeTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="kidsMode"
                  name="kidsMode"
                  disabled={!canEditKidsMode}
                  onChange={() => setFieldValue('kidsMode', !values.kidsMode)}
                />
              </div>
            </div>
            {!!data.libraries?.length && (
              <div className="form-row">
                <span className="text-label">
                  {intl.formatMessage(messages.excludedLibraries)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.excludedLibrariesTip)}
                  </span>
                </span>
                <div className="form-input-area">
                  <div className="flex flex-col gap-2">
                    {data.libraries.map((library) => {
                      const checked = values.excludedLibraries.includes(
                        library.id
                      );
                      return (
                        <label
                          key={library.id}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setFieldValue(
                                'excludedLibraries',
                                checked
                                  ? values.excludedLibraries.filter(
                                      (id) => id !== library.id
                                    )
                                  : [...values.excludedLibraries, library.id]
                              )
                            }
                          />
                          <span>{library.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <div className="actions">
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={isSubmitting}
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
          </Form>
        )}
      </Formik>
      {isOwnProfile && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.ratings)}</h3>
            <p className="description">
              {intl.formatMessage(messages.ratingsDescription)}
            </p>
          </div>
          <div className="section">
            {!feedback ? (
              <LoadingSpinner />
            ) : !feedback.length ? (
              <p className="text-gray-400">
                {intl.formatMessage(messages.noRatings)}
              </p>
            ) : (
              <ul className="divide-y divide-gray-700 rounded-md border border-gray-700">
                {feedback.map((item) => (
                  <li
                    key={`${item.mediaType}-${item.tmdbId}`}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                  >
                    <Link
                      href={`/${item.mediaType}/${item.tmdbId}`}
                      className="truncate hover:underline"
                    >
                      {item.title}
                      {item.year ? ` (${item.year})` : ''}
                    </Link>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Badge badgeType={statusBadge[item.status]}>
                        {intl.formatMessage(messages[item.status])}
                      </Badge>
                      <Button
                        buttonType="ghost"
                        buttonSize="sm"
                        aria-label={intl.formatMessage(messages.remove)}
                        onClick={() => removeFeedback(item)}
                      >
                        <XMarkIcon />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              <div className="flex justify-end">
                <Button
                  buttonType="default"
                  onClick={refresh}
                  disabled={isRefreshing}
                >
                  <ArrowPathIcon
                    className={isRefreshing ? 'animate-spin' : undefined}
                  />
                  <span>
                    {isRefreshing
                      ? intl.formatMessage(messages.refreshing)
                      : intl.formatMessage(messages.refresh)}
                  </span>
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default UserAiSettings;
