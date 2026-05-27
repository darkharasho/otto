import { NumberField } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export function NewConversationSection({
  idleTimeoutMinutes,
  onIdleTimeoutChange,
}: {
  idleTimeoutMinutes: number;
  onIdleTimeoutChange: (minutes: number) => void;
}) {
  return (
    <SubsectionPage
      title="New conversations"
      description="Start a fresh conversation automatically after a period with no activity from you or Otto."
    >
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="flex-1">
          <div className="text-sm">Start a new conversation after</div>
          <div className="text-[11px] text-muted">
            Counts both your messages and Otto&apos;s activity. 0 disables.
          </div>
        </div>
        <NumberField
          value={idleTimeoutMinutes}
          onChange={onIdleTimeoutChange}
          suffix="min"
        />
      </div>
    </SubsectionPage>
  );
}
