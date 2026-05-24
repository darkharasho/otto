import { Section, RadioGroup } from '../SettingsControls';
import type { AutonomyMode } from '@shared/messages';

export function AutonomySection({
  mode,
  onChange,
}: {
  mode: AutonomyMode;
  onChange: (m: AutonomyMode) => void;
}) {
  return (
    <Section title="Autonomy" description="How freely Otto can take action without asking.">
      <RadioGroup<AutonomyMode>
        value={mode}
        onChange={onChange}
        options={[
          { value: 'strict', label: 'Strict', description: 'Ask before any reversible or destructive action.' },
          { value: 'balanced', label: 'Balanced', description: 'Run read-only freely, ask for destructive or irreversible.' },
          { value: 'full-allow', label: 'Full allow', description: 'Run everything without asking. Use at your own risk.' },
        ]}
      />
    </Section>
  );
}
