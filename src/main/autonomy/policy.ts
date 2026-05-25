import type { ActionClass, AutonomyMode } from '@shared/messages';

export type Decision = 'allow' | 'confirm' | 'deny';

const MATRIX: Record<AutonomyMode, Record<ActionClass, Decision>> = {
  strict: {
    read: 'allow',
    reversible: 'confirm',
    destructive: 'confirm',
    irreversible: 'deny',
  },
  balanced: {
    read: 'allow',
    reversible: 'allow',
    destructive: 'confirm',
    irreversible: 'deny',
  },
  'full-allow': {
    read: 'allow',
    reversible: 'allow',
    destructive: 'allow',
    irreversible: 'confirm',
  },
};

export function evaluate(mode: AutonomyMode, actionClass: ActionClass): Decision {
  return MATRIX[mode][actionClass];
}

const ORDER: Record<AutonomyMode, number> = { strict: 0, balanced: 1, 'full-allow': 2 };
export type RemoteCeiling = AutonomyMode | 'match';
export function clamp(desktop: AutonomyMode, ceiling: RemoteCeiling): AutonomyMode {
  if (ceiling === 'match') return desktop;
  return ORDER[ceiling] < ORDER[desktop] ? ceiling : desktop;
}
