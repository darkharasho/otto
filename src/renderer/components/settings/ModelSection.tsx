import { ModelSwitcher } from '../ModelSwitcher';
import { SubsectionPage } from './SubsectionPage';

export function ModelSection({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <SubsectionPage title="Model" description="Used for every new session.">
      <ModelSwitcher value={value} onChange={onChange} />
    </SubsectionPage>
  );
}
