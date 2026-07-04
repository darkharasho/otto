import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export function ReasoningSection({
  showReasoning,
  onChange,
}: {
  showReasoning: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SubsectionPage title="Reasoning">
      <Toggle
        divided
        checked={showReasoning}
        onChange={onChange}
        label="Show reasoning"
        description="Surface Otto's summarized thinking above its answers, in a collapsible card. Otto reasons either way — this only controls whether the summary is shown."
      />
    </SubsectionPage>
  );
}
