# Native right-click context menu

Date: 2026-07-04
Status: approved

## Goal

Otto's windows have no right-click menu (all three call `removeMenu()` and
Electron provides none by default). Add a native, context-sensitive context
menu with the basics: spellcheck suggestions, link copying, and clipboard
editing actions.

## Approach

Native Electron menu built in the main process from `webContents.on('context-menu')`
params — not a custom React menu. Rationale: matches OS behavior, works in
every window and input automatically, ~70 lines, no new dependency. The
existing custom image menu in `ImageCard.tsx` keeps owning images.

## Design

- **New file `src/main/context-menu.ts`:**
  - `buildTemplate(params, actions)` — pure function mapping context-menu
    params to `MenuItemConstructorOptions[]`; unit-testable with stub actions.
  - `attachContextMenu(win)` — subscribes to `webContents.on('context-menu')`,
    builds the template, and `Menu.buildFromTemplate(...).popup()` when
    non-empty.
- **Menu contents, top to bottom (each group separated, shown only when
  relevant):**
  1. Spellcheck: up to 4 `params.dictionarySuggestions` (each calls
     `replaceMisspelling`), then "Add to Dictionary", when
     `params.misspelledWord` is set.
  2. "Copy Link Address" when `params.linkURL` is set (writes to clipboard).
  3. Cut / Copy / Paste / Select All via `role:` items. Cut/Paste/Select All
     only when `params.isEditable`; Cut/Copy additionally require a selection
     (`editFlags.canCut`/`canCopy`); Copy also appears for non-editable
     selected text.
- **Empty template → no popup** (right-click on dead space does nothing).
- **Image guard:** return early when `params.mediaType === 'image'` so the
  native menu never fights ImageCard's custom menu.
- **Spellchecker:** enabled via `session.setSpellCheckerLanguages` derived
  from `app.getLocale()` (fallback `en-US`), set once per session at attach
  time. `webPreferences.spellcheck` is Electron's default (on).
- **Wiring:** `attachContextMenu(win)` called in `window.ts` and
  `settings-window.ts` next to their `removeMenu()` calls. The overlay window
  is excluded: it is fully click-through (`setIgnoreMouseEvents(true)`), so a
  right-click can never reach it. The remote/mobile PWA is untouched.

## Testing

- Unit tests for `buildTemplate` covering: misspelled word, link, editable
  with/without selection, non-editable selection, image (empty), dead space
  (empty).
- Manual: right-click composer typo, message text selection, markdown link,
  chat image (custom menu still), dead space, settings input.
