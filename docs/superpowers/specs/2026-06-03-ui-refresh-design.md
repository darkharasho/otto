# UI Refresh — Design Spec

**Date:** 2026-06-03
**Status:** Approved direction, ready for implementation plan
**Type:** Refine-in-place visual polish (NOT a redesign)

## Goal

The current UI reads as "dated / generic / a bit cluttered." Refresh the whole
chat-app experience so it feels **crafted and modern** while keeping Otto's
identity. We explored eight drastic directions (Quiet, Aurora, Console, Paper,
Slate, Brutalist, Nocturne, Amber CRT) and deliberately rejected all of them in
favor of evolving what we have.

This is a **polish pass over the existing components**, not new architecture.
Layout, structure, component boundaries, and copy stay the same. Nothing for the
user to relearn.

## Hard Constraints

1. **Keep Plus Jakarta Sans** as the product's sans typeface everywhere. The user
   explicitly loves it — this is non-negotiable. JetBrains Mono stays for
   genuinely monospace content only (session ids, code, terminal output,
   tool-call input summaries), exactly as today.
2. **Keep the DNA:** near-black surfaces, violet accent (`#7c7dff` family),
   existing dark palette. No light mode, no new accent hue.
3. **Same layout & component structure.** We restyle; we don't move things.

## Design Language (the polish moves)

These apply consistently across surfaces (with one title-bar exception below):

- **Depth instead of flat.** Primary surfaces (command bar, tool cards, settings
  controls, user bubble) gain a subtle vertical gradient plus a 1px inner
  top-highlight (`inset 0 1px 0 rgba(255,255,255,0.03–0.04)`) and a soft drop
  shadow, so they read as crafted objects rather than plain boxes.
- **Accent that earns its place.** The Otto mark carries a faint radial violet
  halo on the surfaces where it anchors (command bar, "Otto" message label).
  The send button becomes a confident violet **gradient chip**
  (`linear-gradient(135deg,#8889ff,#6e6fff)`) with a soft glow, instead of a bare
  arrow / flat fill.
- **Tighter geometry.** Pull the command-bar / card radius from 16px to ~14px and
  shave a hair of padding — reads more precise, less bubbly.
- **Structured status.** Ambient state becomes scannable: autonomy mode renders
  as a violet pill ("balanced"), the live/working dot glows
  (`box-shadow: 0 0 7px rgba(124,125,255,0.7)`), tool-call status becomes a
  rounded pill rather than bare uppercase text.
- **Calmer type hierarchy.** Steadier placeholder sizing; nudge the muted greys so
  primary/secondary/tertiary text separate more clearly. (Font family unchanged.)

### Token additions (Tailwind / CSS)

Keep existing tokens (`bg #0d0d0e`, `surface #17181a`, `border #2a2b2e`,
`text #e9eaec`, `muted #8b8d92`, `accent #7c7dff`, `danger`). Add a small set of
derived values used by the polish:

- `accent-2: #6e6fff` (gradient partner for `#7c7dff`/`#8889ff`)
- `accent-soft` backgrounds: `rgba(124,125,255,0.10–0.16)`
- `accent-border`: `rgba(124,125,255,0.28–0.34)`
- elevated surface gradient: `linear-gradient(180deg,#1a1b1f,#161619)`
- hairline highlight: `inset 0 1px 0 rgba(255,255,255,0.04)`

Prefer expressing these as reusable utility classes / a couple of `@layer
components` helpers in `index.css` (e.g. `.otto-elevated`, `.otto-accent-pill`,
`.otto-send`) so they're applied uniformly and easy to tune in one place.

## Per-surface spec

### Command bar — `CommandBar.tsx`
- Elevated surface (gradient + inner highlight + shadow), 14px radius.
- Mark gains the violet halo; send button becomes the gradient chip with a thin
  divider before it. Enter `kbd` keeps its role when empty.
- **States** (all already exist — restyle only):
  - *working*: accent-tinted border + ring, glowing border, keep the shimmer
    underline; "stop" affordance restyled (rounded accent-soft square + label).
  - *queued*: "N queued" as quiet muted text alongside stop.
  - *attachment*: thumbnail chip with a subtle fill; divider before actions.
  - *private*: violet lock pill + violet border treatment (already present —
    align to the new pill style).

### Chat — `Message.tsx`, `MessageList.tsx`
- **User bubble:** keep shape/position; swap flat fill for a soft accent gradient
  + 1px accent border + faint lift shadow. Keep `rounded` asymmetry.
- **"Otto" label:** mark gets the small halo; same layout.
- **Body text:** slightly more line-height / clearer grey. Markdown styles in
  `.md` (in `index.css`) get the same calmer treatment. Font unchanged.

### Tool cards — `ToolCallCard.tsx`
- Elevated card (gradient + inner highlight), 10px radius.
- Icon chip becomes a violet **gradient** tile (currently flat `accent/10`).
- Status (`running/done/error`) renders as a **rounded pill** with the glyph +
  label, accent-soft background for done/running, danger for error. Keep the
  collapse/expand and detail body; detail `pre` keeps mono + dark fill.

### Approval card — `ApprovalCard.tsx`
- Elevate to a clearly-actionable accent-framed card with a soft outer glow.
- Action-class tag (read/reversible/destructive/irreversible) as a colored pill
  (reversible = amber, destructive/irreversible = danger, read = muted).
- Command preview in mono on a dark inset panel.
- **Approve** = primary gradient button; **Deny** = quiet outlined button.

### Conversation sidebar — `ConversationSidebar.tsx`, `ConversationSidebarItem.tsx`
- Already strong; light touch. Active item keeps its gradient + accent left-bar +
  inner glow (align values to the system).
- Add a **search field** at the top and a primary **"New conversation"** gradient
  button (if not already surfaced there). Group headers: tidy uppercase muted
  labels with consistent spacing.
- Status dots: running glows/pulses, errored gets a soft danger glow.

### Settings — `SettingsShell.tsx` + sections
- **Top tabs:** replace the heavy solid-accent active fill with an accent-soft
  pill + accent text + 1px inset accent ring; inactive are quiet ghost.
- **Left subnav:** active item gets the accent left-bar + accent-soft gradient
  (consistent with the conversation sidebar).
- **Controls:** mode selector cards get elevation + accent-soft selected state
  with inner glow; toggles become gradient-on / neutral-off pills with a soft
  thumb shadow. Section headers/descriptions use the calmer type hierarchy.

### Chrome — title bar & footer

**Title bar — `ChatTitlebar.tsx` — FLAT GHOST (the one exception to "add depth"):**
- Remove the violet gradient wash; use a flat surface with a hairline bottom
  border.
- Remove the mark halo here (flat, modern).
- Window controls become **ghost buttons**: borderless, icon-only, with a subtle
  `rgba(255,255,255,0.06)` hover background + brighten on hover. No raised
  gradient/border in the resting state.
- Keep mark + "Otto" + session title + LIVE/PRIVATE pills + keyboard hints; just
  flattened and quieted.

**Status footer — `StatusFooter.tsx` + `ModeBadge.tsx`:** keep crafted depth.
- Model badge: subtle bordered chip.
- Mode badge: violet **shield pill** (icon + label).
- Private: violet lock pill. Session id stays mono/muted.

## Remote / PWA UI

`src/renderer-remote/*` mirrors several of these components (chat, approval,
tool cards). Apply the same token/treatment updates there for consistency, but
it is **secondary** — desktop is the primary target and can land first.

## Out of scope

- No layout/IA changes, no new screens, no copy rewrites.
- No light mode, no font change, no new accent color.
- No component/architecture refactors beyond extracting shared style helpers.
- No animation overhaul (keep existing `otto-*` keyframes; reuse, don't replace).

## Testing & implementation notes

- These are styling changes; existing component tests (`*.test.tsx`) assert
  behavior/structure and should largely keep passing. Update only snapshot/class
  assertions that hard-code restyled class strings.
- Centralize the new values as utilities/tokens first (`tailwind.config.ts`,
  `index.css`), then apply per component — so the look is tunable in one place
  and stays consistent.
- Verify against real states by running the app (command bar working/queued/
  private, an approval prompt, an errored tool call, an active+errored sidebar
  item, each settings section).

## Reference mockups

Live HTML mockups produced during brainstorming are under
`.superpowers/brainstorm/` (command-bar directions, refined chat, full-app
composite, chrome specimen sheet, flat title-bar variants).
