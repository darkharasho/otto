import { Section, Toggle } from '../SettingsControls';

export function StartupSection({
  startAtLogin,
  onChange,
}: {
  startAtLogin: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Section title="Startup">
      <Toggle
        checked={startAtLogin}
        onChange={onChange}
        label="Start at login"
        description="Run Otto in the background when you sign in."
      />
    </Section>
  );
}
