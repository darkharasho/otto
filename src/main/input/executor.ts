import type { CursorPosition, MouseButton, PlatformAdapter } from '../platform';

export type InputAction =
  | { kind: 'cursorPosition' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'scroll'; dx: number; dy: number; x?: number; y?: number }
  | { kind: 'click'; x: number; y: number; button: MouseButton }
  | { kind: 'doubleClick'; x: number; y: number; button: MouseButton }
  | { kind: 'drag'; x1: number; y1: number; x2: number; y2: number; button: MouseButton }
  | { kind: 'type'; text: string }
  | { kind: 'key'; combo: string };

export async function exec(
  action: InputAction,
  adapter: PlatformAdapter,
  delayMs: number
): Promise<unknown> {
  const input = adapter.input;
  switch (action.kind) {
    case 'cursorPosition': {
      const pos: CursorPosition = await input.cursorPosition();
      return pos;
    }
    case 'move':
      await input.move(action.x, action.y);
      break;
    case 'scroll':
      await input.scroll(action.dx, action.dy, action.x, action.y);
      break;
    case 'click':
      await input.click(action.x, action.y, action.button);
      break;
    case 'doubleClick':
      await input.doubleClick(action.x, action.y, action.button);
      break;
    case 'drag':
      await input.drag(action.x1, action.y1, action.x2, action.y2, action.button);
      break;
    case 'type':
      await input.type(action.text);
      break;
    case 'key':
      await input.key(action.combo);
      break;
  }
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}
