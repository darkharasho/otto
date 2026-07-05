import { app, clipboard, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

const MAX_SPELL_SUGGESTIONS = 4;

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  copyLink(url: string): void;
}

/**
 * Map right-click params to a native menu template. Pure so tests can drive
 * it with stub actions; groups (spellcheck | link | edit) are separated and
 * only included when relevant, so an empty result means "show no menu".
 */
export function buildTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions
): MenuItemConstructorOptions[] {
  // ImageCard.tsx renders its own styled menu for images; the native menu
  // stays out of the way entirely.
  if (params.mediaType === 'image') return [];

  const groups: MenuItemConstructorOptions[][] = [];

  if (params.misspelledWord) {
    const spell: MenuItemConstructorOptions[] = params.dictionarySuggestions
      .slice(0, MAX_SPELL_SUGGESTIONS)
      .map((suggestion) => ({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion),
      }));
    spell.push({
      label: 'Add to Dictionary',
      click: () => actions.addToDictionary(params.misspelledWord),
    });
    groups.push(spell);
  }

  if (params.linkURL) {
    groups.push([
      { label: 'Copy Link Address', click: () => actions.copyLink(params.linkURL) },
    ]);
  }

  if (params.isEditable) {
    groups.push([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText.trim().length > 0) {
    groups.push([{ role: 'copy', enabled: params.editFlags.canCopy }]);
  }

  return groups.flatMap((group, i) =>
    i === 0 ? group : [{ type: 'separator' as const }, ...group]
  );
}

/**
 * The spellchecker itself is on by default (webPreferences.spellcheck), but
 * Chromium needs a language list before it marks misspellings. Per-session,
 * once.
 */
const spellcheckConfigured = new WeakSet<Electron.Session>();
function ensureSpellchecker(session: Electron.Session): void {
  if (spellcheckConfigured.has(session)) return;
  spellcheckConfigured.add(session);
  try {
    const locale = app.getLocale() || 'en-US';
    const available = session.availableSpellCheckerLanguages;
    session.setSpellCheckerLanguages(available.includes(locale) ? [locale] : ['en-US']);
  } catch (err) {
    // Non-fatal: the menu still works, just without suggestions.
    console.warn('[context-menu] spellchecker setup failed:', err);
  }
}

/** Native right-click menu with the basics; see buildTemplate for contents. */
export function attachContextMenu(win: BrowserWindow): void {
  const wc = win.webContents;
  ensureSpellchecker(wc.session);
  wc.on('context-menu', (_event, params) => {
    const template = buildTemplate(params, {
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      addToDictionary: (word) => wc.session.addWordToSpellCheckerDictionary(word),
      copyLink: (url) => clipboard.writeText(url),
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
