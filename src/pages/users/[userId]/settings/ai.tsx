import UserSettings from '@app/components/UserProfile/UserSettings';
import UserAiSettings from '@app/components/UserProfile/UserSettings/UserAiSettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const UserAiSettingsPage: NextPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserAiSettings />
    </UserSettings>
  );
};

export default UserAiSettingsPage;
