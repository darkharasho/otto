import { Section, Toggle, RadioGroup } from '../SettingsControls';

export type WindowPosition = 'bottom-center' | 'top-center';

interface Props {
  windowPosition: WindowPosition;
  hideOnBlur: boolean;
  onPositionChange: (p: WindowPosition) => void;
  onHideOnBlurChange: (v: boolean) => void;
}

export function WindowSection({
  windowPosition,
  hideOnBlur,
  onPositionChange,
  onHideOnBlurChange,
}: Props) {
  return (
    <Section title="Window" description="Where the bar and panel appear when summoned.">
      <RadioGroup<WindowPosition>
        value={windowPosition}
        onChange={onPositionChange}
        options={[
          { value: 'bottom-center', label: 'Bottom center', description: 'Grows upward as the panel opens.' },
          { value: 'top-center', label: 'Top center', description: 'Grows downward as the panel opens.' },
        ]}
      />
      <Toggle
        checked={hideOnBlur}
        onChange={onHideOnBlurChange}
        label="Hide when clicked away"
        description="When on, clicking outside Otto hides it (like a popover). When off, Otto stays open until you dismiss it with the hotkey."
      />
    </Section>
  );
}
