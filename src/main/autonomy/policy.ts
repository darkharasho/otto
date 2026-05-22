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
