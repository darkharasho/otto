import { Section, Toggle } from '../SettingsControls';

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
    <Section title="Notifications">
      <Toggle
        checked={notifications.turnComplete}
        onChange={(v) => onChange({ turnComplete: v })}
        label="When Otto finishes responding"
        description="Only fires when the Otto window isn't focused."
      />
      <Toggle
        checked={notifications.approval}
        onChange={(v) => onChange({ approval: v })}
        label="When Otto needs approval"
        description="Critical priority — won't be silenced by Do Not Disturb."
      />
      <Toggle
        checked={notifications.sound}
        onChange={(v) => onChange({ sound: v })}
        label="Play sound"
      />
    </Section>
  );
}
