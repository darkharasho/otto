import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTemplate, type ContextMenuActions } from './context-menu';

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  app: { getLocale: vi.fn(() => 'en-US') },
}));

function makeParams(overrides: Partial<Electron.ContextMenuParams> = {}): Electron.ContextMenuParams {
  return {
    x: 0,
    y: 0,
    linkURL: '',
    linkText: '',
    pageURL: '',
    frameURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: {} as Electron.Referrer['policy'] as never,
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: '',
    formControlType: 'none',
    spellcheckEnabled: false,
    menuSourceType: 'mouse',
    mediaFlags: {
      inError: false, isPaused: false, isMuted: false, hasAudio: false,
      isLooping: false, isControlsVisible: false, canToggleControls: false,
      canPrint: false, canSave: false, canShowPictureInPicture: false,
      isShowingPictureInPicture: false, canRotate: false, canLoop: false,
    },
    editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false,
      canPaste: false, canDelete: false, canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  } as Electron.ContextMenuParams;
}

describe('buildTemplate', () => {
  let actions: ContextMenuActions;

  beforeEach(() => {
    actions = {
      replaceMisspelling: vi.fn(),
      addToDictionary: vi.fn(),
      copyLink: vi.fn(),
    };
  });

  it('returns empty for dead space (nothing applicable)', () => {
    expect(buildTemplate(makeParams(), actions)).toEqual([]);
  });

  it('returns empty for images so ImageCard keeps its custom menu', () => {
    const params = makeParams({
      mediaType: 'image',
      hasImageContents: true,
      // Even with a selection/link present, images are skipped entirely.
      linkURL: 'https://example.com',
      selectionText: 'x',
    });
    expect(buildTemplate(params, actions)).toEqual([]);
  });

  it('offers Copy alone for a non-editable text selection', () => {
    const params = makeParams({
      selectionText: 'hello',
      editFlags: { ...makeParams().editFlags, canCopy: true },
    });
    const tpl = buildTemplate(params, actions);
    expect(tpl.map((i) => i.role)).toEqual(['copy']);
  });

  it('offers the full edit group in an editable field', () => {
    const params = makeParams({
      isEditable: true,
      selectionText: 'sel',
      editFlags: {
        ...makeParams().editFlags,
        canCut: true, canCopy: true, canPaste: true, canSelectAll: true,
      },
    });
    const tpl = buildTemplate(params, actions);
    expect(tpl.map((i) => i.role)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(tpl.every((i) => i.enabled !== false)).toBe(true);
  });

  it('disables cut/copy in an editable field with no selection, keeps paste', () => {
    const params = makeParams({
      isEditable: true,
      editFlags: { ...makeParams().editFlags, canPaste: true, canSelectAll: true },
    });
    const tpl = buildTemplate(params, actions);
    const byRole = Object.fromEntries(tpl.map((i) => [i.role, i]));
    expect(byRole.cut.enabled).toBe(false);
    expect(byRole.copy.enabled).toBe(false);
    expect(byRole.paste.enabled).toBe(true);
    expect(byRole.selectAll.enabled).toBe(true);
  });

  it('adds Copy Link Address for links and invokes the action with the URL', () => {
    const params = makeParams({ linkURL: 'https://otto.dev/x' });
    const tpl = buildTemplate(params, actions);
    const link = tpl.find((i) => i.label === 'Copy Link Address');
    expect(link).toBeDefined();
    (link!.click as () => void)();
    expect(actions.copyLink).toHaveBeenCalledWith('https://otto.dev/x');
  });

  it('puts spellcheck suggestions first, capped at 4, then Add to Dictionary', () => {
    const params = makeParams({
      isEditable: true,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello', 'halo', 'help', 'hell', 'helot'],
      editFlags: { ...makeParams().editFlags, canPaste: true, canSelectAll: true },
    });
    const tpl = buildTemplate(params, actions);
    const labels = tpl.map((i) => i.label ?? i.role ?? (i.type === 'separator' ? '---' : '?'));
    expect(labels.slice(0, 5)).toEqual(['hello', 'halo', 'help', 'hell', 'Add to Dictionary']);
    (tpl[0].click as () => void)();
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('hello');
    const add = tpl.find((i) => i.label === 'Add to Dictionary')!;
    (add.click as () => void)();
    expect(actions.addToDictionary).toHaveBeenCalledWith('helo');
  });

  it('separates groups with separators and never leaves a dangling one', () => {
    const params = makeParams({
      isEditable: true,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
      linkURL: 'https://otto.dev',
      editFlags: { ...makeParams().editFlags, canPaste: true, canSelectAll: true },
    });
    const tpl = buildTemplate(params, actions);
    expect(tpl[0].type).not.toBe('separator');
    expect(tpl[tpl.length - 1].type).not.toBe('separator');
    // spellcheck group | link group | edit group → exactly two separators
    expect(tpl.filter((i) => i.type === 'separator')).toHaveLength(2);
  });
});
