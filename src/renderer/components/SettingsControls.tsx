import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <div className="text-xs font-semibold text-text">{title}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={[
        'flex items-start gap-3 py-1.5 cursor-pointer select-none',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={[
          'mt-0.5 relative w-8 h-[18px] rounded-full border transition-colors flex-shrink-0',
          checked
            ? 'bg-accent border-accent'
            : 'bg-bg/60 border-border hover:border-accent/60',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[1px] w-[14px] h-[14px] rounded-full bg-white transition-transform duration-150',
            checked ? 'translate-x-[15px]' : 'translate-x-[1px]',
          ].join(' ')}
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text leading-tight">{label}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>
    </label>
  );
}

export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="space-y-1">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'relative w-full text-left pl-3 pr-2.5 py-2 rounded-lg transition-colors',
              active ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg/60',
            ].join(' ')}
          >
            {active && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />
            )}
            <div className="text-sm font-medium">{opt.label}</div>
            {opt.description && (
              <div className="text-[11px] text-muted mt-0.5">{opt.description}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function NumberField({
  value,
  onChange,
  min = 0,
  suffix,
}: {
  value: number;
  onChange(v: number): void;
  min?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (Number.isFinite(v) && v >= min) onChange(v);
        }}
        className="w-20 px-2 py-1 text-sm rounded-md bg-bg/60 border border-border text-text outline-none focus:border-accent/70"
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </div>
  );
}
