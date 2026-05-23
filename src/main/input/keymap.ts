export interface KeyEvent {
  code: number;
  state: 0 | 1;
}

export function translateKeyCombo(combo: string): KeyEvent[] {
  const tokens = combo.split('+').map((t) => t.trim());
  if (tokens.length === 0) throw new Error('empty key combo');

  const codes = tokens.map(tokenToCode);
  const modifiers = codes.slice(0, -1);
  const key = codes[codes.length - 1]!;

  const events: KeyEvent[] = [];
  for (const m of modifiers) events.push({ code: m, state: 1 });
  events.push({ code: key, state: 1 });
  events.push({ code: key, state: 0 });
  for (const m of [...modifiers].reverse()) events.push({ code: m, state: 0 });
  return events;
}

function tokenToCode(token: string): number {
  const direct = NAME_TO_CODE[token];
  if (direct !== undefined) return direct;
  const alias = ALIASES[token];
  if (alias !== undefined) {
    const aliasCode = NAME_TO_CODE[alias];
    if (aliasCode !== undefined) return aliasCode;
  }
  if (token.length === 1) {
    const ch = token.toLowerCase();
    const letterCode = LETTERS[ch];
    if (letterCode !== undefined) return letterCode;
    const digitCode = DIGITS[ch];
    if (digitCode !== undefined) return digitCode;
  }
  throw new Error(`unknown key: ${token}`);
}

const ALIASES: Record<string, string> = {
  Enter: 'Return',
  Meta: 'Super',
};

const NAME_TO_CODE: Record<string, number> = {
  Control: 29,
  Alt: 56,
  Shift: 42,
  Super: 125,
  Return: 28,
  Tab: 15,
  Escape: 1,
  Space: 57,
  Backspace: 14,
  Delete: 111,
  Up: 103,
  Down: 108,
  Left: 105,
  Right: 106,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
};

const LETTERS: Record<string, number> = {
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
};

const DIGITS: Record<string, number> = {
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
};
