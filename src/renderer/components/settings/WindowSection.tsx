import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Toggle, RadioGroup } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export type WindowPosition = 'bottom-center' | 'top-center';
export type DisplayTarget = 'cursor' | 'primary';

interface Props {
  windowPosition: WindowPosition;
  displayTarget: DisplayTarget;
  hideOnBlur: boolean;
  onPositionChange: (p: WindowPosition) => void;
  onDisplayTargetChange: (t: DisplayTarget) => void;
  onHideOnBlurChange: (v: boolean) => void;
}

export function WindowSection({
  windowPosition,
  displayTarget,
  hideOnBlur,
  onPositionChange,
  onDisplayTargetChange,
  onHideOnBlurChange,
}: Props) {
  return (
    <SubsectionPage title="Window" description="Where the bar and panel appear when summoned.">
      <RadioGroup<WindowPosition>
        value={windowPosition}
        onChange={onPositionChange}
        options={[
          { value: 'bottom-center', label: 'Bottom center', description: 'Grows upward as the panel opens.' },
          { value: 'top-center', label: 'Top center', description: 'Grows downward as the panel opens.' },
        ]}
      />
      <div className="mt-4">
        <div className="text-[11px] font-semibold text-muted uppercase tracking-wide mb-2">Display</div>
        <RadioGroup<DisplayTarget>
          value={displayTarget}
          onChange={onDisplayTargetChange}
          options={[
            { value: 'cursor', label: 'Follow cursor', description: 'Opens on whichever monitor the cursor is on.' },
            { value: 'primary', label: 'Primary display', description: 'Always opens on your primary monitor.' },
          ]}
        />
        <div className="text-[11px] text-muted mt-2 flex items-center gap-1.5 flex-wrap">
          <span>Tip: press</span>
          <kbd className="px-1.5 py-0.5 rounded bg-bg/60 border border-border text-[10px] inline-flex items-center gap-1">
            Ctrl+Shift+<ArrowLeft className="w-3 h-3" aria-label="Left arrow" />
          </kbd>
          <span>or</span>
          <kbd className="px-1.5 py-0.5 rounded bg-bg/60 border border-border text-[10px] inline-flex items-center gap-1">
            Ctrl+Shift+<ArrowRight className="w-3 h-3" aria-label="Right arrow" />
          </kbd>
          <span>while Otto is open to move it between monitors.</span>
        </div>
      </div>
      <Toggle
        checked={hideOnBlur}
        onChange={onHideOnBlurChange}
        label="Hide when clicked away"
        description="When on, clicking outside Otto hides it (like a popover). When off, Otto stays open until you dismiss it with the hotkey."
      />
    </SubsectionPage>
  );
}
