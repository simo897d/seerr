import UserSettings from '@app/components/UserProfile/UserSettings';
import UserAiSettings from '@app/components/UserProfile/UserSettings/UserAiSettings';
import type { NextPage } from 'next';

const UserAiSettingsPage: NextPage = () => {
  return (
    <UserSettings>
      <UserAiSettings />
    </UserSettings>
  );
};

export default UserAiSettingsPage;
