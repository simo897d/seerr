import Button from '@app/components/Common/Button';
import useAiEnabled from '@app/hooks/useAiEnabled';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  MinusCircleIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TitleFeedback', {
  prompt: 'Seen it? Tell the AI what you thought',
  watched: 'Watched',
  liked: 'Loved it',
  meh: 'It was OK',
  disliked: 'Not for me',
  saveFailed: 'Something went wrong while saving your rating.',
});

type Status = 'watched' | 'liked' | 'meh' | 'disliked';

interface TitleFeedbackProps {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}

/**
 * Lets users mark a title as watched (e.g. seen outside the media server)
 * and say whether they loved it, found it OK or didn't like it, to tailor
 * their AI recommendations.
 */
const TitleFeedback = ({ mediaType, tmdbId }: TitleFeedbackProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const enabled = useAiEnabled().recommendations;
  const url = `/api/v1/feedback/${mediaType}/${tmdbId}`;
  const { data, mutate } = useSWR<{ status: Status | null }>(
    enabled ? url : null
  );
  const [isSaving, setIsSaving] = useState(false);

  if (!enabled || !data) {
    return null;
  }

  // Clicking the active choice clears it. Unticking "Watched" clears a
  // rating too, since rating a title implies having seen it.
  const choose = async (status: Status) => {
    const next = data.status === status ? null : status;
    setIsSaving(true);
    try {
      if (next) {
        await axios.post(url, { status: next });
      } else {
        await axios.delete(url);
      }
      await mutate({ status: next }, { revalidate: false });
    } catch {
      addToast(intl.formatMessage(messages.saveFailed), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const watchedActive = !!data.status;
  const options: {
    status: Status;
    label: string;
    icon: React.ReactNode;
    active: boolean;
    activeType: 'primary' | 'success' | 'warning' | 'danger';
  }[] = [
    {
      status: 'watched',
      label: intl.formatMessage(messages.watched),
      icon: <CheckCircleIcon />,
      active: watchedActive,
      activeType: 'primary',
    },
    {
      status: 'liked',
      label: intl.formatMessage(messages.liked),
      icon: <HandThumbUpIcon />,
      active: data.status === 'liked',
      activeType: 'success',
    },
    {
      status: 'meh',
      label: intl.formatMessage(messages.meh),
      icon: <MinusCircleIcon />,
      active: data.status === 'meh',
      activeType: 'warning',
    },
    {
      status: 'disliked',
      label: intl.formatMessage(messages.disliked),
      icon: <HandThumbDownIcon />,
      active: data.status === 'disliked',
      activeType: 'danger',
    },
  ];

  return (
    <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="text-sm text-gray-400">
        {intl.formatMessage(messages.prompt)}
      </span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.status}
            buttonSize="sm"
            buttonType={option.active ? option.activeType : 'ghost'}
            disabled={isSaving}
            aria-pressed={option.active}
            onClick={() =>
              // "Watched" while rated clears everything
              option.status === 'watched' && watchedActive
                ? choose(data.status as Status)
                : choose(option.status)
            }
          >
            {option.icon}
            <span>{option.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
};

export default TitleFeedback;
