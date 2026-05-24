import { Section } from '../SettingsControls';

export function AboutSection({
  version,
  onOpenLogs,
}: {
  version: string;
  onOpenLogs: () => void;
}) {
  return (
    <Section title="About">
      <div className="flex items-center justify-between text-xs text-muted py-1">
        <span>Otto v{version}</span>
        <button type="button" onClick={onOpenLogs} className="text-accent hover:underline">
          Open logs folder
        </button>
      </div>
    </Section>
  );
}
