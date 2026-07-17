import { RadioGroup } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';
import type { TopicShiftSensitivity } from '@shared/topic-shift-constants';

export function TopicShiftSection({
  sensitivity,
  onChange,
}: {
  sensitivity: TopicShiftSensitivity;
  onChange: (s: TopicShiftSensitivity) => void;
}) {
  return (
    <SubsectionPage
      title="Topic shifts"
      description="When you come back after a while and send something that looks unrelated, Otto can offer to start a fresh conversation."
    >
      <RadioGroup<TopicShiftSensitivity>
        value={sensitivity}
        onChange={onChange}
        options={[
          { value: 'off', label: 'Off', description: 'Never offer to start a new conversation.' },
          {
            value: 'low',
            label: 'Low',
            description: 'Only after a long pause, and only for clearly unrelated messages. Recommended.',
          },
          { value: 'medium', label: 'Medium', description: 'Balanced — the previous default.' },
          { value: 'high', label: 'High', description: 'Eager — suggests after short pauses and subtler shifts.' },
        ]}
      />
    </SubsectionPage>
  );
}
