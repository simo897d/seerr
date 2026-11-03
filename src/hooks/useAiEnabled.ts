import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';

/**
 * Whether AI recommendations and chat are on for the signed-in user. With
 * the Claude subscription provider only the server owner gets them.
 */
const useAiEnabled = () => {
  const { currentSettings } = useSettings();
  const { user } = useUser();
  const allowed = !currentSettings.aiOwnerOnly || user?.id === 1;

  return {
    recommendations: currentSettings.aiRecommendationsEnabled && allowed,
    chat: currentSettings.aiChatEnabled && allowed,
  };
};

export default useAiEnabled;
