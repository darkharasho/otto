import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export function StartupSection({
  startAtLogin,
  onChange,
}: {
  startAtLogin: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SubsectionPage title="Startup">
      <Toggle
        checked={startAtLogin}
        onChange={onChange}
        label="Start at login"
        description="Run Otto in the background when you sign in."
      />
    </SubsectionPage>
  );
}
