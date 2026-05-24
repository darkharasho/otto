import { ModelSwitcher } from '../ModelSwitcher';
import { Section } from '../SettingsControls';

export function ModelSection({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <Section title="Model" description="Used for every new session.">
      <ModelSwitcher value={value} onChange={onChange} />
    </Section>
  );
}
