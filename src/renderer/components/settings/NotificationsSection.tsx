import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export interface NotificationsState {
  turnComplete: boolean;
  approval: boolean;
  sound: boolean;
}

export function NotificationsSection({
  notifications,
  onChange,
}: {
  notifications: NotificationsState;
  onChange: (patch: Partial<NotificationsState>) => void;
}) {
  return (
    <SubsectionPage title="Notifications">
      <Toggle
        divided
        checked={notifications.turnComplete}
        onChange={(v) => onChange({ turnComplete: v })}
        label="When Otto finishes responding"
        description="Only fires when the Otto window isn't focused."
      />
      <Toggle
        divided
        checked={notifications.approval}
        onChange={(v) => onChange({ approval: v })}
        label="When Otto needs approval"
        description="Critical priority — won't be silenced by Do Not Disturb."
      />
      <Toggle
        divided
        checked={notifications.sound}
        onChange={(v) => onChange({ sound: v })}
        label="Play sound"
      />
    </SubsectionPage>
  );
}
